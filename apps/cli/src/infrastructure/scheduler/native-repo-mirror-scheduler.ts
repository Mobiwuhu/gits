import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import type {
  RepoMirrorScheduledInvocation,
  RepoMirrorScheduler,
  RepoMirrorSchedulerObservation,
} from '../../application/ports/repo-mirror-scheduler.js'
import type { RepoMirrorDefinition } from '../../domain/repo-mirror/model.js'
import { writeFileAtomically } from '../filesystem/atomic-file.js'
import {
  gitsExternalPersistenceRegistry,
  resolveLaunchdProjectionDirectory,
  resolveSystemdTimerEnablementDirectory,
  resolveSystemdUserUnitDirectory,
} from '../persistence/gits-persistence-registry.js'
import {
  NodeSystemCommandRunner,
  type SystemCommandRunner,
} from '../process/system-command-runner.js'
import { readOrCreateInstallationId, type GitsPaths } from '../repo-mirrors/gits-paths.js'
import { renderLaunchdPlist } from './launchd-plist-renderer.js'
import { compileCalendarEntries } from './portable-cron.js'
import { StableRunnerInstaller } from './stable-runner-installer.js'
import { renderSystemdUnits } from './systemd-unit-renderer.js'

export interface PlatformInfo {
  readonly platform: NodeJS.Platform
  readonly uid: number | null
}

export interface NativeRepoMirrorSchedulerOptions {
  readonly environment?: NodeJS.ProcessEnv
  readonly platformInfo?: PlatformInfo
  readonly runner?: SystemCommandRunner
  readonly stableRunner?: StableRunnerInstaller
  readonly userHome?: string
}

interface NativeJobIdentity {
  readonly label: string
  readonly serviceName: string
  readonly timerName: string
}

export class NativeRepoMirrorScheduler implements RepoMirrorScheduler {
  readonly #environment: NodeJS.ProcessEnv
  readonly #paths: GitsPaths
  readonly #platform: PlatformInfo
  readonly #runner: SystemCommandRunner
  readonly #stableRunner: StableRunnerInstaller
  readonly #userHome: string

  constructor(paths: GitsPaths, options: NativeRepoMirrorSchedulerOptions = {}) {
    this.#paths = paths
    this.#environment = options.environment ?? process.env
    this.#platform = options.platformInfo ?? {
      platform: process.platform,
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
    }
    this.#runner = options.runner ?? new NodeSystemCommandRunner()
    this.#stableRunner = options.stableRunner ?? new StableRunnerInstaller(paths)
    this.#userHome = options.userHome ?? homedir()
  }

  invocation(name: string): RepoMirrorScheduledInvocation {
    return this.#stableRunner.invocation(name)
  }

  async apply(definition: RepoMirrorDefinition): Promise<RepoMirrorSchedulerObservation> {
    if (definition.schedule === undefined) return this.remove(definition.name)
    await this.#stableRunner.install()
    const entries = compileCalendarEntries(definition.schedule.cron)
    if (this.#platform.platform === 'darwin') return this.applyLaunchd(definition, entries)
    if (this.#platform.platform === 'linux') return this.applySystemd(definition, entries)
    return unsupportedObservation('Native scheduling is supported only on macOS and Linux.')
  }

  async inspect(definition: RepoMirrorDefinition): Promise<RepoMirrorSchedulerObservation> {
    if (definition.schedule === undefined) {
      return {
        backend: backendFor(this.#platform.platform),
        nativeJob: null,
        projectionPath: null,
        state: 'off',
      }
    }
    const entries = compileCalendarEntries(definition.schedule.cron)
    if (this.#platform.platform === 'darwin') return this.inspectLaunchd(definition, entries)
    if (this.#platform.platform === 'linux') return this.inspectSystemd(definition, entries)
    return unsupportedObservation('Native scheduling is supported only on macOS and Linux.')
  }

  async remove(name: string): Promise<RepoMirrorSchedulerObservation> {
    if (this.#platform.platform === 'darwin') return this.removeLaunchd(name)
    if (this.#platform.platform === 'linux') return this.removeSystemd(name)
    return {
      backend: 'unsupported',
      nativeJob: null,
      projectionPath: null,
      state: 'off',
    }
  }

  async applyLaunchd(
    definition: RepoMirrorDefinition,
    entries: ReturnType<typeof compileCalendarEntries>,
  ): Promise<RepoMirrorSchedulerObservation> {
    const identity = await this.identity(definition.name)
    const path = this.launchdPath(identity.label)
    const nativeLog = resolve(this.#paths.logs, `${definition.name}.native.log`)
    await mkdir(resolveLaunchdProjectionDirectory(this.#userHome), {
      mode: 0o700,
      recursive: true,
    })
    await mkdir(this.#paths.logs, { mode: 0o700, recursive: true })
    const content = renderLaunchdPlist({
      calendarEntries: entries,
      invocation: this.invocation(definition.name),
      label: identity.label,
      standardErrorPath: nativeLog,
      standardOutputPath: nativeLog,
    })
    const existing = await readOptional(path)
    if (existing !== null && !existing.includes(`<string>${identity.label}</string>`)) {
      return launchdObservation(
        identity.label,
        path,
        'drifted',
        'Refusing to overwrite a LaunchAgent that is not managed by gits.',
      )
    }
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFileAtomically(temporary, content)
    try {
      const lint = await this.#runner.run('/usr/bin/plutil', ['-lint', temporary])
      if (lint.exitCode !== 0) {
        return launchdObservation(identity.label, path, 'unavailable', nonEmpty(lint.stderr))
      }
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }

    if (this.#platform.uid === null) {
      return launchdObservation(identity.label, path, 'unavailable', 'Cannot determine user id.')
    }
    const domain = `gui/${this.#platform.uid}`
    try {
      const capability = await this.#runner.run('/bin/launchctl', ['print', domain])
      if (capability.exitCode !== 0) {
        return launchdObservation(identity.label, path, 'unavailable', nonEmpty(capability.stderr))
      }
      await this.#runner.run('/bin/launchctl', ['bootout', domain, path])
      await this.#runner.run('/bin/launchctl', ['enable', `${domain}/${identity.label}`])
      const loaded = await this.#runner.run('/bin/launchctl', ['bootstrap', domain, path])
      return loaded.exitCode === 0
        ? launchdObservation(identity.label, path, 'ready')
        : launchdObservation(identity.label, path, 'unavailable', nonEmpty(loaded.stderr))
    } catch (error) {
      return launchdObservation(
        identity.label,
        path,
        'unavailable',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  async inspectLaunchd(
    definition: RepoMirrorDefinition,
    entries: ReturnType<typeof compileCalendarEntries>,
  ): Promise<RepoMirrorSchedulerObservation> {
    const identity = await this.identity(definition.name)
    const path = this.launchdPath(identity.label)
    const nativeLog = resolve(this.#paths.logs, `${definition.name}.native.log`)
    const expected = renderLaunchdPlist({
      calendarEntries: entries,
      invocation: this.invocation(definition.name),
      label: identity.label,
      standardErrorPath: nativeLog,
      standardOutputPath: nativeLog,
    })
    const actual = await readOptional(path)
    if (actual !== expected) return launchdObservation(identity.label, path, 'drifted')
    if (this.#platform.uid === null) return launchdObservation(identity.label, path, 'unavailable')
    try {
      const loaded = await this.#runner.run('/bin/launchctl', [
        'print',
        `gui/${this.#platform.uid}/${identity.label}`,
      ])
      return loaded.exitCode === 0
        ? launchdObservation(identity.label, path, 'ready')
        : launchdObservation(identity.label, path, 'unavailable', nonEmpty(loaded.stderr))
    } catch (error) {
      return launchdObservation(
        identity.label,
        path,
        'unavailable',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  async removeLaunchd(name: string): Promise<RepoMirrorSchedulerObservation> {
    const identity = await this.identity(name)
    const path = this.launchdPath(identity.label)
    const existing = await readOptional(path)
    if (existing !== null && !existing.includes(`<string>${identity.label}</string>`)) {
      return launchdObservation(
        identity.label,
        path,
        'drifted',
        'Refusing to remove a LaunchAgent that is not managed by gits.',
      )
    }
    if (this.#platform.uid !== null) {
      const domain = `gui/${this.#platform.uid}`
      try {
        await this.#runner.run('/bin/launchctl', ['bootout', domain, path])
        await this.#runner.run('/bin/launchctl', ['enable', `${domain}/${identity.label}`])
      } catch {
        // The projection is still safe to remove when no GUI launchd domain is available.
      }
    }
    await rm(path, { force: true })
    return launchdObservation(identity.label, path, 'off')
  }

  async applySystemd(
    definition: RepoMirrorDefinition,
    entries: ReturnType<typeof compileCalendarEntries>,
  ): Promise<RepoMirrorSchedulerObservation> {
    const identity = await this.identity(definition.name)
    const paths = this.systemdPaths(identity)
    const nativeLog = resolve(this.#paths.logs, `${definition.name}.native.log`)
    await mkdir(paths.directory, { mode: 0o700, recursive: true })
    await mkdir(this.#paths.logs, { mode: 0o700, recursive: true })
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
      (existingService !== null && !existingService.includes('X-Gits-Managed=true')) ||
      (existingTimer !== null && !existingTimer.includes('X-Gits-Managed=true'))
    ) {
      return systemdObservation(
        identity.timerName,
        paths.timer,
        'drifted',
        'Refusing to overwrite a systemd unit that is not managed by gits.',
      )
    }
    await writeFileAtomically(paths.service, units.service)
    await writeFileAtomically(paths.timer, units.timer)
    try {
      const verified = await this.#runner.run('systemd-analyze', [
        '--user',
        'verify',
        paths.service,
        paths.timer,
      ])
      if (verified.exitCode !== 0) {
        return systemdObservation(
          identity.timerName,
          paths.timer,
          'unavailable',
          nonEmpty(verified.stderr),
        )
      }
      const reload = await this.#runner.run('systemctl', ['--user', 'daemon-reload'])
      if (reload.exitCode !== 0) {
        return systemdObservation(
          identity.timerName,
          paths.timer,
          'unavailable',
          nonEmpty(reload.stderr),
        )
      }
      const enabled = await this.#runner.run('systemctl', [
        '--user',
        'enable',
        '--now',
        identity.timerName,
      ])
      return enabled.exitCode === 0
        ? systemdObservation(identity.timerName, paths.timer, 'ready')
        : systemdObservation(
            identity.timerName,
            paths.timer,
            'unavailable',
            nonEmpty(enabled.stderr),
          )
    } catch (error) {
      return systemdObservation(
        identity.timerName,
        paths.timer,
        'unavailable',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  async inspectSystemd(
    definition: RepoMirrorDefinition,
    entries: ReturnType<typeof compileCalendarEntries>,
  ): Promise<RepoMirrorSchedulerObservation> {
    const identity = await this.identity(definition.name)
    const paths = this.systemdPaths(identity)
    const nativeLog = resolve(this.#paths.logs, `${definition.name}.native.log`)
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
      return systemdObservation(identity.timerName, paths.timer, 'drifted')
    }
    try {
      const [enabled, active] = await Promise.all([
        this.#runner.run('systemctl', ['--user', 'is-enabled', identity.timerName]),
        this.#runner.run('systemctl', ['--user', 'is-active', identity.timerName]),
      ])
      return enabled.exitCode === 0 && active.exitCode === 0
        ? systemdObservation(identity.timerName, paths.timer, 'ready')
        : systemdObservation(identity.timerName, paths.timer, 'unavailable')
    } catch (error) {
      return systemdObservation(
        identity.timerName,
        paths.timer,
        'unavailable',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  async removeSystemd(name: string): Promise<RepoMirrorSchedulerObservation> {
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
        'drifted',
        'Refusing to remove a systemd unit that is not managed by gits.',
      )
    }
    try {
      await this.#runner.run('systemctl', ['--user', 'disable', '--now', identity.timerName])
    } catch {
      // A missing user manager must not prevent removing the generated projection.
    }
    await Promise.all([
      rm(paths.service, { force: true }),
      rm(paths.timer, { force: true }),
      rm(paths.timerEnablement, { force: true }),
    ])
    try {
      await this.#runner.run('systemctl', ['--user', 'daemon-reload'])
      await this.#runner.run('systemctl', ['--user', 'clean', '--what=state', identity.timerName])
    } catch {
      // Desired schedule is already off; doctor can retry native cleanup later.
    }
    return systemdObservation(identity.timerName, paths.timer, 'off')
  }

  async identity(name: string): Promise<NativeJobIdentity> {
    const installationId = await readOrCreateInstallationId(this.#paths)
    const instanceKey = createHash('sha256').update(installationId).digest('hex').slice(0, 12)
    const stem = `${gitsExternalPersistenceRegistry.systemdRepoMirrorJobs.filePrefix}${instanceKey}-${name}`
    return {
      label: `${gitsExternalPersistenceRegistry.launchdRepoMirrorJobs.filePrefix}${instanceKey}.${name}`,
      serviceName: `${stem}.service`,
      timerName: `${stem}.timer`,
    }
  }

  launchdPath(label: string): string {
    return resolve(
      resolveLaunchdProjectionDirectory(this.#userHome),
      `${label}${gitsExternalPersistenceRegistry.launchdRepoMirrorJobs.fileSuffix}`,
    )
  }

  systemdPaths(identity: NativeJobIdentity): Readonly<{
    directory: string
    service: string
    timer: string
    timerEnablement: string
  }> {
    const directory = resolveSystemdUserUnitDirectory(this.#environment, this.#userHome)
    return {
      directory,
      service: resolve(directory, identity.serviceName),
      timer: resolve(directory, identity.timerName),
      timerEnablement: resolve(
        resolveSystemdTimerEnablementDirectory(this.#environment, this.#userHome),
        identity.timerName,
      ),
    }
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null
    throw error
  }
}

function launchdObservation(
  label: string,
  path: string,
  state: RepoMirrorSchedulerObservation['state'],
  message: string | null = null,
): RepoMirrorSchedulerObservation {
  return {
    backend: 'launchd',
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
  message: string | null = null,
): RepoMirrorSchedulerObservation {
  return {
    backend: 'systemd',
    ...(message === null ? {} : { message }),
    nativeJob: timer,
    projectionPath: path,
    state,
  }
}

function unsupportedObservation(message: string): RepoMirrorSchedulerObservation {
  return {
    backend: 'unsupported',
    message,
    nativeJob: null,
    projectionPath: null,
    state: 'unavailable',
  }
}

function backendFor(platform: NodeJS.Platform): RepoMirrorSchedulerObservation['backend'] {
  if (platform === 'darwin') return 'launchd'
  if (platform === 'linux') return 'systemd'
  return 'unsupported'
}

function nonEmpty(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
