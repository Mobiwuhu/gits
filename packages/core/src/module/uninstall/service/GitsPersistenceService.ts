import { createHash } from 'node:crypto'
import { readFile, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, parse as parsePath, relative, resolve } from 'node:path'

import { Inject } from '@wendellhu/redi'
import { parse } from 'plist'

import {
  GitsPersistenceTargetKind,
  GitsPersistenceTargetScope,
  IGitsPathService,
  IProcessService,
  UninstallSafetyError,
} from '../../../contract/index'
import type {
  GitsPersistencePurgeResult,
  GitsPersistenceTarget,
  IGitsPersistenceService,
} from '../../../contract/index'
import {
  gitsExternalPersistenceRegistry,
  gitsHomePersistenceKeys,
  gitsHomePersistenceRegistry,
  gitsManagedArtifactKeys,
  gitsManagedArtifactRegistry,
  gitsPersistenceRootRegistry,
  registeredTopLevelNames,
  resolveLaunchdProjectionDirectory,
  resolveSystemdTimerEnablementDirectory,
  resolveSystemdUserUnitDirectory,
} from '../../../service/index'
import {
  errorMessage,
  hasErrorCode,
  pathEntryExists,
} from '../../../util/index'

export interface GitsPersistenceServiceOptions {
  readonly environment?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly uid?: number | null
  readonly userHome?: string
}

export class GitsPersistenceService implements IGitsPersistenceService {
  readonly #environment: NodeJS.ProcessEnv
  readonly #platform: NodeJS.Platform
  readonly #uid: number | null
  readonly #userHome: string

  constructor(
    @Inject(IGitsPathService) private readonly paths: IGitsPathService,
    @Inject(IProcessService) private readonly runner: IProcessService,
    options: GitsPersistenceServiceOptions = {}
  ) {
    this.#environment = options.environment ?? process.env
    this.#platform = options.platform ?? process.platform
    this.#uid =
      options.uid ??
      (typeof process.getuid === 'function' ? process.getuid() : null)
    this.#userHome = options.userHome ?? homedir()
  }

  async inspect(): Promise<readonly GitsPersistenceTarget[]> {
    let external: Promise<readonly GitsPersistenceTarget[]> = Promise.resolve(
      []
    )
    if (this.#platform === 'darwin') {
      external = this.discoverLaunchdProjections()
    }
    if (this.#platform === 'linux') {
      external = this.discoverSystemdProjections()
    }
    const [home, projections] = await Promise.all([
      this.inspectHome(),
      external,
    ])
    return [...home, ...projections].toSorted((left, right) =>
      left.path.localeCompare(right.path)
    )
  }

  async purge(signal?: AbortSignal): Promise<GitsPersistencePurgeResult> {
    signal?.throwIfAborted()
    await this.assertSafeDataRoot()
    const targets = await this.inspect()
    const external = targets.filter(
      (target) =>
        target.scope === GitsPersistenceTargetScope.External && target.exists
    )
    const warnings: string[] = []
    const systemdTimers = external
      .filter(
        (target) =>
          target.id.startsWith('systemd:') && target.path.endsWith('.timer')
      )
      .map((target) => basename(target.path))

    if (this.#platform === 'darwin') {
      warnings.push(...(await this.stopLaunchdJobs(external)))
    } else if (this.#platform === 'linux') {
      warnings.push(...(await this.stopSystemdJobs(systemdTimers)))
    }

    await Promise.all(
      external.map(async (target) => rm(target.path, { force: true }))
    )
    if (this.#platform === 'linux') {
      warnings.push(...(await this.reloadSystemdJobs(systemdTimers)))
    }
    const dataRootExists = await pathEntryExists(this.paths.home)
    if (dataRootExists) {
      await rm(this.paths.home, { force: true, recursive: true })
    }
    return {
      removedPaths: [
        ...external.map((target) => target.path),
        ...(dataRootExists ? [this.paths.home] : []),
      ],
      warnings,
    }
  }

  private async inspectHome(): Promise<readonly GitsPersistenceTarget[]> {
    const dataRootExists = await pathEntryExists(this.paths.home)
    const registered = await Promise.all(
      gitsHomePersistenceKeys.map(
        async (id): Promise<GitsPersistenceTarget> => {
          const entry = gitsHomePersistenceRegistry[id]
          return {
            description: entry.description,
            exists: await pathEntryExists(this.paths[id]),
            id,
            kind: entry.kind,
            path: this.paths[id],
            scope: GitsPersistenceTargetScope.GitsHome,
          }
        }
      )
    )
    const managedArtifacts: readonly GitsPersistenceTarget[] =
      await Promise.all(
        gitsManagedArtifactKeys.map(
          async (id): Promise<GitsPersistenceTarget> => {
            const artifact = gitsManagedArtifactRegistry[id]
            const path = resolve(this.paths[artifact.parent], artifact.fileName)
            return {
              description: artifact.description,
              exists: await pathEntryExists(path),
              id,
              kind: GitsPersistenceTargetKind.File,
              path,
              scope: GitsPersistenceTargetScope.GitsHome,
            }
          }
        )
      )
    const unknown = dataRootExists ? await this.unregisteredHomeEntries() : []
    return [
      {
        description: `${gitsPersistenceRootRegistry.description}; removed recursively`,
        exists: dataRootExists,
        id: 'gits-home',
        kind: GitsPersistenceTargetKind.DataRoot,
        path: this.paths.home,
        scope: GitsPersistenceTargetScope.GitsHome,
      },
      ...registered,
      ...managedArtifacts,
      ...unknown,
    ]
  }

  private async unregisteredHomeEntries(): Promise<
    readonly GitsPersistenceTarget[]
  > {
    const known = registeredTopLevelNames()
    let entries: string[]
    try {
      entries = await readdir(this.paths.home)
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return []
      }
      throw error
    }
    return entries
      .filter((entry) => !known.has(entry))
      .map((entry) => ({
        description: 'Unregistered content below the exclusive gits data root',
        exists: true,
        id: `unregistered:${entry}`,
        kind: GitsPersistenceTargetKind.Unregistered,
        path: resolve(this.paths.home, entry),
        scope: GitsPersistenceTargetScope.GitsHome,
      }))
  }

  private async discoverLaunchdProjections(): Promise<
    readonly GitsPersistenceTarget[]
  > {
    const catalog = gitsExternalPersistenceRegistry.launchdRepoMirrorJobs
    const directory = resolveLaunchdProjectionDirectory(this.#userHome)
    const names = await matchingEntries(directory, catalog.filePrefix, [
      catalog.fileSuffix,
    ])
    const targets = await Promise.all(
      names.map(async (name): Promise<GitsPersistenceTarget | null> => {
        const path = resolve(directory, name)
        const content = await readOptional(path)
        if (content === null || !this.isOwnedLaunchdProjection(name, content)) {
          return null
        }
        return {
          description: catalog.description,
          exists: true,
          id: `launchd:${name}`,
          kind: GitsPersistenceTargetKind.NativeProjection,
          path,
          scope: GitsPersistenceTargetScope.External,
        }
      })
    )
    return targets.filter(
      (target): target is GitsPersistenceTarget => target !== null
    )
  }

  private isOwnedLaunchdProjection(name: string, content: string): boolean {
    try {
      const value: unknown = parse(content)
      if (!isRecord(value)) {
        return false
      }
      const label = value.Label
      const environment = value.EnvironmentVariables
      const programArguments = value.ProgramArguments
      const expectedLabel = name.slice(
        0,
        -gitsExternalPersistenceRegistry.launchdRepoMirrorJobs.fileSuffix.length
      )
      return (
        label === expectedLabel &&
        typeof label === 'string' &&
        label.startsWith(
          gitsExternalPersistenceRegistry.launchdRepoMirrorJobs.filePrefix
        ) &&
        isRecord(environment) &&
        environment.GITS_HOME === this.paths.home &&
        Array.isArray(programArguments) &&
        programArguments[0] === this.stableRunnerPath()
      )
    } catch {
      return false
    }
  }

  private async discoverSystemdProjections(): Promise<
    readonly GitsPersistenceTarget[]
  > {
    const catalog = gitsExternalPersistenceRegistry.systemdRepoMirrorJobs
    const directory = resolveSystemdUserUnitDirectory(
      this.#environment,
      this.#userHome
    )
    const names = await matchingEntries(
      directory,
      catalog.filePrefix,
      catalog.fileSuffixes
    )
    const instanceKey = await this.installationKey()
    const instancePrefix =
      instanceKey === null ? null : `${catalog.filePrefix}${instanceKey}-`
    const files = await Promise.all(
      names.map(async (name) => ({
        content: await readOptional(resolve(directory, name)),
        name,
      }))
    )
    const ownedServiceStems = new Set<string>()
    for (const file of files) {
      if (
        file.name.endsWith('.service') &&
        file.content !== null &&
        this.isOwnedSystemdService(file.name, file.content, instancePrefix)
      ) {
        ownedServiceStems.add(file.name.slice(0, -'.service'.length))
      }
    }

    const units: GitsPersistenceTarget[] = files
      .filter((file) => {
        if (
          file.content === null ||
          !file.content.includes('X-Gits-Managed=true')
        ) {
          return false
        }
        const stem = file.name.replace(/\.(?:service|timer)$/u, '')
        return (
          ownedServiceStems.has(stem) ||
          (instancePrefix !== null && file.name.startsWith(instancePrefix))
        )
      })
      .map((file) => ({
        description: catalog.description,
        exists: true,
        id: `systemd:${file.name}`,
        kind: GitsPersistenceTargetKind.NativeProjection,
        path: resolve(directory, file.name),
        scope: GitsPersistenceTargetScope.External,
      }))
    const enablementDirectory = resolveSystemdTimerEnablementDirectory(
      this.#environment,
      this.#userHome
    )
    const enabledTimers = await matchingEntries(
      enablementDirectory,
      catalog.filePrefix,
      ['.timer']
    )
    const enablements: GitsPersistenceTarget[] = enabledTimers
      .filter((name) => {
        const stem = name.slice(0, -'.timer'.length)
        return (
          ownedServiceStems.has(stem) ||
          (instancePrefix !== null && name.startsWith(instancePrefix))
        )
      })
      .map((name) => ({
        description: `${catalog.description} enablement link`,
        exists: true,
        id: `systemd-enablement:${name}`,
        kind: GitsPersistenceTargetKind.NativeProjection,
        path: resolve(enablementDirectory, name),
        scope: GitsPersistenceTargetScope.External,
      }))
    return [...units, ...enablements]
  }

  private isOwnedSystemdService(
    name: string,
    content: string,
    instancePrefix: string | null
  ): boolean {
    if (!content.includes('X-Gits-Managed=true')) {
      return false
    }
    if (instancePrefix !== null && name.startsWith(instancePrefix)) {
      return true
    }
    return (
      content.includes(`GITS_HOME=${escapeSystemdValue(this.paths.home)}`) &&
      content.includes(
        gitsManagedArtifactRegistry.stableSchedulerRunner.fileName
      )
    )
  }

  private async installationKey(): Promise<string | null> {
    const value = await readOptional(this.paths.installationId)
    if (value === null || value.trim().length === 0) {
      return null
    }
    return createHash('sha256').update(value.trim()).digest('hex').slice(0, 12)
  }

  private async assertSafeDataRoot(): Promise<void> {
    if (!(await pathEntryExists(this.paths.home))) {
      return
    }
    const { root } = parsePath(this.paths.home)
    const userHome = resolve(this.#userHome)
    const candidate = resolve(this.paths.home)
    if (candidate === root || isEqualOrParent(candidate, userHome)) {
      throw new UninstallSafetyError(
        `Refusing to recursively remove unsafe GITS_HOME: ${candidate}`
      )
    }

    const defaultHome = resolve(
      userHome,
      gitsPersistenceRootRegistry.defaultDirectoryName
    )
    if (candidate === defaultHome) {
      return
    }
    const installationId = await readOptional(this.paths.installationId)
    if (installationId === null || !isUuid(installationId.trim())) {
      throw new UninstallSafetyError(
        `Refusing to remove custom GITS_HOME without a valid installation-id: ${candidate}`
      )
    }
  }

  private async stopLaunchdJobs(
    targets: readonly GitsPersistenceTarget[]
  ): Promise<readonly string[]> {
    if (this.#uid === null) {
      return ['Could not determine uid; LaunchAgent files were removed only.']
    }
    const domain = `gui/${this.#uid}`
    const results = await Promise.all(
      targets
        .filter((item) => item.id.startsWith('launchd:'))
        .map(async (target): Promise<string | null> => {
          try {
            await this.runner.run('/bin/launchctl', [
              'bootout',
              domain,
              target.path,
            ])
            const label = basename(target.path, '.plist')
            await this.runner.run('/bin/launchctl', [
              'enable',
              `${domain}/${label}`,
            ])
            return null
          } catch (error) {
            return `Could not fully unload ${target.path}: ${errorMessage(error)}`
          }
        })
    )
    return results.filter((result): result is string => result !== null)
  }

  private async stopSystemdJobs(
    timers: readonly string[]
  ): Promise<readonly string[]> {
    const warnings: string[] = []
    try {
      await Promise.all(
        timers.map(async (timer) =>
          this.runner.run('systemctl', ['--user', 'disable', '--now', timer])
        )
      )
    } catch (error) {
      warnings.push(
        `Could not fully unload systemd user jobs: ${errorMessage(error)}`
      )
    }
    return warnings
  }

  private async reloadSystemdJobs(
    timers: readonly string[]
  ): Promise<readonly string[]> {
    try {
      await this.runner.run('systemctl', ['--user', 'daemon-reload'])
      await Promise.all(
        timers.map(async (timer) =>
          this.runner.run('systemctl', [
            '--user',
            'clean',
            '--what=state',
            timer,
          ])
        )
      )
      return []
    } catch (error) {
      return [
        `Could not reload the systemd user manager: ${errorMessage(error)}`,
      ]
    }
  }

  private stableRunnerPath(): string {
    return resolve(
      this.paths.bin,
      gitsManagedArtifactRegistry.stableSchedulerRunner.fileName
    )
  }
}

async function matchingEntries(
  directory: string,
  prefix: string,
  suffixes: readonly string[]
): Promise<readonly string[]> {
  try {
    const entries = await readdir(directory)
    return entries.filter(
      (entry) =>
        entry.startsWith(prefix) &&
        suffixes.some((suffix) => entry.endsWith(suffix))
    )
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return []
    }
    throw error
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null
    }
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isEqualOrParent(candidate: string, target: string): boolean {
  const difference = relative(candidate, target)
  return (
    difference === '' ||
    (!difference.startsWith('..') && !parsePath(difference).root)
  )
}

function isUuid(value: string): boolean {
  return /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu.test(
    value
  )
}

function escapeSystemdValue(value: string): string {
  return value
    .replaceAll('%', '%%')
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
}
