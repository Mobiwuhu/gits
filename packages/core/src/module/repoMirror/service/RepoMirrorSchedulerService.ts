import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { Inject } from '@wendellhu/redi'

import {
  IFileSystemService,
  IGitsPathService,
  IProcessService,
  IStableRunnerInstaller,
  RepoMirrorScheduleState,
  RepoMirrorSchedulerBackend,
} from '../../../contract/index'
import type {
  IRepoMirrorSchedulerService,
  RepoMirrorDefinition,
  RepoMirrorScheduledInvocation,
  RepoMirrorSchedulerObservation,
} from '../../../contract/index'
import {
  gitsExternalPersistenceRegistry,
  resolveLaunchdProjectionDirectory,
  resolveSystemdTimerEnablementDirectory,
  resolveSystemdUserUnitDirectory,
} from '../../../service/index'
import { renderLaunchdPlist } from './launchdPlistRenderer'
import { compileCalendarEntries } from './portableCron'
import { renderSystemdUnits } from './systemdUnitRenderer'

export interface PlatformInfo {
  readonly platform: NodeJS.Platform
  readonly uid: number | null
}

export interface NativeRepoMirrorSchedulerOptions {
  readonly environment?: NodeJS.ProcessEnv
  readonly platformInfo?: PlatformInfo
  readonly userHome?: string
}

interface NativeJobIdentity {
  readonly label: string
  readonly serviceName: string
  readonly timerName: string
}

export class RepoMirrorSchedulerService implements IRepoMirrorSchedulerService {
  readonly #environment: NodeJS.ProcessEnv
  readonly #platform: PlatformInfo
  readonly #userHome: string

  constructor(
    @Inject(IGitsPathService) private readonly paths: IGitsPathService,
    @Inject(IProcessService) private readonly runner: IProcessService,
    @Inject(IStableRunnerInstaller)
    private readonly stableRunner: IStableRunnerInstaller,
    @Inject(IFileSystemService) private readonly fileSystem: IFileSystemService,
    options: NativeRepoMirrorSchedulerOptions = {}
  ) {
    this.#environment = options.environment ?? process.env
    this.#platform = options.platformInfo ?? {
      platform: process.platform,
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
    }
    this.#userHome = options.userHome ?? homedir()
  }

  invocation(name: string): RepoMirrorScheduledInvocation {
    return this.stableRunner.invocation(name)
  }

  async apply(
    definition: RepoMirrorDefinition
  ): Promise<RepoMirrorSchedulerObservation> {
    if (definition.schedule === undefined) {
      return this.remove(definition.name)
    }
    await this.stableRunner.install()
    const entries = compileCalendarEntries(definition.schedule.cron)
    if (this.#platform.platform === 'darwin') {
      return this.applyLaunchd(definition, entries)
    }
    if (this.#platform.platform === 'linux') {
      return this.applySystemd(definition, entries)
    }
    return unsupportedObservation(
      'Native scheduling is supported only on macOS and Linux.'
    )
  }

  async inspect(
    definition: RepoMirrorDefinition
  ): Promise<RepoMirrorSchedulerObservation> {
    if (definition.schedule === undefined) {
      return {
        backend: backendFor(this.#platform.platform),
        nativeJob: null,
        projectionPath: null,
        state: RepoMirrorScheduleState.Off,
      }
    }
    const entries = compileCalendarEntries(definition.schedule.cron)
    if (this.#platform.platform === 'darwin') {
      return this.inspectLaunchd(definition, entries)
    }
    if (this.#platform.platform === 'linux') {
      return this.inspectSystemd(definition, entries)
    }
    return unsupportedObservation(
      'Native scheduling is supported only on macOS and Linux.'
    )
  }

  async remove(name: string): Promise<RepoMirrorSchedulerObservation> {
    if (this.#platform.platform === 'darwin') {
      return this.removeLaunchd(name)
    }
    if (this.#platform.platform === 'linux') {
      return this.removeSystemd(name)
    }
    return {
      backend: RepoMirrorSchedulerBackend.Unsupported,
      nativeJob: null,
      projectionPath: null,
      state: RepoMirrorScheduleState.Off,
    }
  }

  private async applyLaunchd(
    definition: RepoMirrorDefinition,
    entries: ReturnType<typeof compileCalendarEntries>
  ): Promise<RepoMirrorSchedulerObservation> {
    const identity = await this.identity(definition.name)
    const path = this.launchdPath(identity.label)
    const nativeLog = resolve(this.paths.logs, `${definition.name}.native.log`)
    await mkdir(resolveLaunchdProjectionDirectory(this.#userHome), {
      mode: 0o700,
      recursive: true,
    })
    await mkdir(this.paths.logs, { mode: 0o700, recursive: true })
    const content = renderLaunchdPlist({
      calendarEntries: entries,
      invocation: this.invocation(definition.name),
      label: identity.label,
      standardErrorPath: nativeLog,
      standardOutputPath: nativeLog,
    })
    const existing = await readOptional(path)
    if (
      existing !== null &&
      !existing.includes(`<string>${identity.label}</string>`)
    ) {
      return launchdObservation(
        identity.label,
        path,
        RepoMirrorScheduleState.Drifted,
        'Refusing to overwrite a LaunchAgent that is not managed by gits.'
      )
    }
    const temporary = `${path}.${randomUUID()}.tmp`
    await this.fileSystem.writeFileAtomically(temporary, content)
    try {
      const lint = await this.runner.run('/usr/bin/plutil', [
        '-lint',
        temporary,
      ])
      if (lint.exitCode !== 0) {
        return launchdObservation(
          identity.label,
          path,
          RepoMirrorScheduleState.Unavailable,
          nonEmpty(lint.stderr)
        )
      }
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }

    if (this.#platform.uid === null) {
      return launchdObservation(
        identity.label,
        path,
        RepoMirrorScheduleState.Unavailable,
        'Cannot determine user id.'
      )
    }
    const domain = `gui/${this.#platform.uid}`
    try {
      const capability = await this.runner.run('/bin/launchctl', [
        'print',
        domain,
      ])
      if (capability.exitCode !== 0) {
        return launchdObservation(
          identity.label,
          path,
          RepoMirrorScheduleState.Unavailable,
          nonEmpty(capability.stderr)
        )
      }
      await this.runner.run('/bin/launchctl', ['bootout', domain, path])
      await this.runner.run('/bin/launchctl', [
        'enable',
        `${domain}/${identity.label}`,
      ])
      const loaded = await this.runner.run('/bin/launchctl', [
        'bootstrap',
        domain,
        path,
      ])
      return loaded.exitCode === 0
        ? launchdObservation(
            identity.label,
            path,
            RepoMirrorScheduleState.Ready
          )
        : launchdObservation(
            identity.label,
            path,
            RepoMirrorScheduleState.Unavailable,
            nonEmpty(loaded.stderr)
          )
    } catch (error) {
      return launchdObservation(
        identity.label,
        path,
        RepoMirrorScheduleState.Unavailable,
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  private async inspectLaunchd(
    definition: RepoMirrorDefinition,
    entries: ReturnType<typeof compileCalendarEntries>
  ): Promise<RepoMirrorSchedulerObservation> {
    const identity = await this.identity(definition.name)
    const path = this.launchdPath(identity.label)
    const stableRunner = await this.stableRunner.inspect()
    if (stableRunner.state !== RepoMirrorScheduleState.Ready) {
      return launchdObservation(
        identity.label,
        path,
        stableRunner.state,
        stableRunner.message ?? 'Stable scheduler runner is unavailable.'
      )
    }
    const nativeLog = resolve(this.paths.logs, `${definition.name}.native.log`)
    const expected = renderLaunchdPlist({
      calendarEntries: entries,
      invocation: this.invocation(definition.name),
      label: identity.label,
      standardErrorPath: nativeLog,
      standardOutputPath: nativeLog,
    })
    const actual = await readOptional(path)
    if (actual !== expected) {
      return launchdObservation(
        identity.label,
        path,
        RepoMirrorScheduleState.Drifted
      )
    }
    if (this.#platform.uid === null) {
      return launchdObservation(
        identity.label,
        path,
        RepoMirrorScheduleState.Unavailable
      )
    }
    try {
      const loaded = await this.runner.run('/bin/launchctl', [
        'print',
        `gui/${this.#platform.uid}/${identity.label}`,
      ])
      return loaded.exitCode === 0
        ? launchdObservation(
            identity.label,
            path,
            RepoMirrorScheduleState.Ready
          )
        : launchdObservation(
            identity.label,
            path,
            RepoMirrorScheduleState.Unavailable,
            nonEmpty(loaded.stderr)
          )
    } catch (error) {
      return launchdObservation(
        identity.label,
        path,
        RepoMirrorScheduleState.Unavailable,
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  private async removeLaunchd(
    name: string
  ): Promise<RepoMirrorSchedulerObservation> {
    const identity = await this.identity(name)
    const path = this.launchdPath(identity.label)
    const existing = await readOptional(path)
    if (
      existing !== null &&
      !existing.includes(`<string>${identity.label}</string>`)
    ) {
      return launchdObservation(
        identity.label,
        path,
        RepoMirrorScheduleState.Drifted,
        'Refusing to remove a LaunchAgent that is not managed by gits.'
      )
    }
    if (this.#platform.uid !== null) {
      const domain = `gui/${this.#platform.uid}`
      try {
        await this.runner.run('/bin/launchctl', ['bootout', domain, path])
        await this.runner.run('/bin/launchctl', [
          'enable',
          `${domain}/${identity.label}`,
        ])
      } catch {
        // 即使没有可用的 GUI launchd 域，删除投影文件仍然安全。
      }
    }
    await rm(path, { force: true })
    return launchdObservation(identity.label, path, RepoMirrorScheduleState.Off)
  }

  private async applySystemd(
    definition: RepoMirrorDefinition,
    entries: ReturnType<typeof compileCalendarEntries>
  ): Promise<RepoMirrorSchedulerObservation> {
    const identity = await this.identity(definition.name)
    const paths = this.systemdPaths(identity)
    const nativeLog = resolve(this.paths.logs, `${definition.name}.native.log`)
    await mkdir(paths.directory, { mode: 0o700, recursive: true })
    await mkdir(this.paths.logs, { mode: 0o700, recursive: true })
    const units = renderSystemdUnits({
      calendarEntries: entries,
      invocation: this.invocation(definition.name),
      name: identity.serviceName.replace(/\.service$/u, ''),
      standardErrorPath: nativeLog,
      standardOutputPath: nativeLog,
    })
    const [existingService, existingTimer] = await Promise.all([
      readOptional(paths.service),
      readOptional(paths.timer),
    ])
    if (
      (existingService !== null &&
        !existingService.includes('X-Gits-Managed=true')) ||
      (existingTimer !== null && !existingTimer.includes('X-Gits-Managed=true'))
    ) {
      return systemdObservation(
        identity.timerName,
        paths.timer,
        RepoMirrorScheduleState.Drifted,
        'Refusing to overwrite a systemd unit that is not managed by gits.'
      )
    }
    await this.fileSystem.writeFileAtomically(paths.service, units.service)
    await this.fileSystem.writeFileAtomically(paths.timer, units.timer)
    try {
      const verified = await this.runner.run('systemd-analyze', [
        '--user',
        'verify',
        paths.service,
        paths.timer,
      ])
      if (verified.exitCode !== 0) {
        return systemdObservation(
          identity.timerName,
          paths.timer,
          RepoMirrorScheduleState.Unavailable,
          nonEmpty(verified.stderr)
        )
      }
      const reload = await this.runner.run('systemctl', [
        '--user',
        'daemon-reload',
      ])
      if (reload.exitCode !== 0) {
        return systemdObservation(
          identity.timerName,
          paths.timer,
          RepoMirrorScheduleState.Unavailable,
          nonEmpty(reload.stderr)
        )
      }
      const enabled = await this.runner.run('systemctl', [
        '--user',
        'enable',
        '--now',
        identity.timerName,
      ])
      return enabled.exitCode === 0
        ? systemdObservation(
            identity.timerName,
            paths.timer,
            RepoMirrorScheduleState.Ready
          )
        : systemdObservation(
            identity.timerName,
            paths.timer,
            RepoMirrorScheduleState.Unavailable,
            nonEmpty(enabled.stderr)
          )
    } catch (error) {
      return systemdObservation(
        identity.timerName,
        paths.timer,
        RepoMirrorScheduleState.Unavailable,
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  private async inspectSystemd(
    definition: RepoMirrorDefinition,
    entries: ReturnType<typeof compileCalendarEntries>
  ): Promise<RepoMirrorSchedulerObservation> {
    const identity = await this.identity(definition.name)
    const paths = this.systemdPaths(identity)
    const stableRunner = await this.stableRunner.inspect()
    if (stableRunner.state !== RepoMirrorScheduleState.Ready) {
      return systemdObservation(
        identity.timerName,
        paths.timer,
        stableRunner.state,
        stableRunner.message ?? 'Stable scheduler runner is unavailable.'
      )
    }
    const nativeLog = resolve(this.paths.logs, `${definition.name}.native.log`)
    const expected = renderSystemdUnits({
      calendarEntries: entries,
      invocation: this.invocation(definition.name),
      name: identity.serviceName.replace(/\.service$/u, ''),
      standardErrorPath: nativeLog,
      standardOutputPath: nativeLog,
    })
    const [service, timer] = await Promise.all([
      readOptional(paths.service),
      readOptional(paths.timer),
    ])
    if (service !== expected.service || timer !== expected.timer) {
      return systemdObservation(
        identity.timerName,
        paths.timer,
        RepoMirrorScheduleState.Drifted
      )
    }
    try {
      const [enabled, active] = await Promise.all([
        this.runner.run('systemctl', [
          '--user',
          'is-enabled',
          identity.timerName,
        ]),
        this.runner.run('systemctl', [
          '--user',
          'is-active',
          identity.timerName,
        ]),
      ])
      return enabled.exitCode === 0 && active.exitCode === 0
        ? systemdObservation(
            identity.timerName,
            paths.timer,
            RepoMirrorScheduleState.Ready
          )
        : systemdObservation(
            identity.timerName,
            paths.timer,
            RepoMirrorScheduleState.Unavailable
          )
    } catch (error) {
      return systemdObservation(
        identity.timerName,
        paths.timer,
        RepoMirrorScheduleState.Unavailable,
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  private async removeSystemd(
    name: string
  ): Promise<RepoMirrorSchedulerObservation> {
    const identity = await this.identity(name)
    const paths = this.systemdPaths(identity)
    const [service, timer] = await Promise.all([
      readOptional(paths.service),
      readOptional(paths.timer),
    ])
    if (
      (service !== null && !service.includes('X-Gits-Managed=true')) ||
      (timer !== null && !timer.includes('X-Gits-Managed=true'))
    ) {
      return systemdObservation(
        identity.timerName,
        paths.timer,
        RepoMirrorScheduleState.Drifted,
        'Refusing to remove a systemd unit that is not managed by gits.'
      )
    }
    try {
      await this.runner.run('systemctl', [
        '--user',
        'disable',
        '--now',
        identity.timerName,
      ])
    } catch {
      // 用户级管理器不存在时，仍应继续删除已生成的投影文件。
    }
    await Promise.all([
      rm(paths.service, { force: true }),
      rm(paths.timer, { force: true }),
      rm(paths.timerEnablement, { force: true }),
    ])
    try {
      await this.runner.run('systemctl', ['--user', 'daemon-reload'])
      await this.runner.run('systemctl', [
        '--user',
        'clean',
        '--what=state',
        identity.timerName,
      ])
    } catch {
      // 目标调度已经关闭，doctor 后续可以重试原生资源清理。
    }
    return systemdObservation(
      identity.timerName,
      paths.timer,
      RepoMirrorScheduleState.Off
    )
  }

  private async identity(name: string): Promise<NativeJobIdentity> {
    const installationId = await this.paths.readOrCreateInstallationId()
    const instanceKey = createHash('sha256')
      .update(installationId)
      .digest('hex')
      .slice(0, 12)
    const stem = `${gitsExternalPersistenceRegistry.systemdRepoMirrorJobs.filePrefix}${instanceKey}-${name}`
    return {
      label: `${gitsExternalPersistenceRegistry.launchdRepoMirrorJobs.filePrefix}${instanceKey}.${name}`,
      serviceName: `${stem}.service`,
      timerName: `${stem}.timer`,
    }
  }

  private launchdPath(label: string): string {
    return resolve(
      resolveLaunchdProjectionDirectory(this.#userHome),
      `${label}${gitsExternalPersistenceRegistry.launchdRepoMirrorJobs.fileSuffix}`
    )
  }

  private systemdPaths(identity: NativeJobIdentity): Readonly<{
    directory: string
    service: string
    timer: string
    timerEnablement: string
  }> {
    const directory = resolveSystemdUserUnitDirectory(
      this.#environment,
      this.#userHome
    )
    return {
      directory,
      service: resolve(directory, identity.serviceName),
      timer: resolve(directory, identity.timerName),
      timerEnablement: resolve(
        resolveSystemdTimerEnablementDirectory(
          this.#environment,
          this.#userHome
        ),
        identity.timerName
      ),
    }
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return null
    }
    throw error
  }
}

function launchdObservation(
  label: string,
  path: string,
  state: RepoMirrorSchedulerObservation['state'],
  message: string | null = null
): RepoMirrorSchedulerObservation {
  return {
    backend: RepoMirrorSchedulerBackend.Launchd,
    ...(message === null ? {} : { message }),
    nativeJob: label,
    projectionPath: path,
    state,
  }
}

function systemdObservation(
  timer: string,
  path: string,
  state: RepoMirrorSchedulerObservation['state'],
  message: string | null = null
): RepoMirrorSchedulerObservation {
  return {
    backend: RepoMirrorSchedulerBackend.Systemd,
    ...(message === null ? {} : { message }),
    nativeJob: timer,
    projectionPath: path,
    state,
  }
}

function unsupportedObservation(
  message: string
): RepoMirrorSchedulerObservation {
  return {
    backend: RepoMirrorSchedulerBackend.Unsupported,
    message,
    nativeJob: null,
    projectionPath: null,
    state: RepoMirrorScheduleState.Unavailable,
  }
}

function backendFor(
  platform: NodeJS.Platform
): RepoMirrorSchedulerObservation['backend'] {
  if (platform === 'darwin') {
    return RepoMirrorSchedulerBackend.Launchd
  }
  if (platform === 'linux') {
    return RepoMirrorSchedulerBackend.Systemd
  }
  return RepoMirrorSchedulerBackend.Unsupported
}

function nonEmpty(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  )
}
