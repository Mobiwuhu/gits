import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, parse as parsePath, relative, resolve } from 'node:path'

import { parse } from 'plist'

import type {
  GitsPersistence,
  GitsPersistencePurgeResult,
  GitsPersistenceTarget,
} from '../../application/ports/gits-persistence.js'
import { UninstallSafetyError } from '../../domain/task/errors.js'
import {
  NodeSystemCommandRunner,
  type SystemCommandRunner,
} from '../process/system-command-runner.js'
import type { GitsPaths } from '../repo-mirrors/gits-paths.js'
import {
  gitsExternalPersistenceRegistry,
  gitsHomePersistenceRegistry,
  gitsManagedArtifactRegistry,
  gitsPersistenceRootRegistry,
  registeredTopLevelNames,
  resolveLaunchdProjectionDirectory,
  resolveSystemdTimerEnablementDirectory,
  resolveSystemdUserUnitDirectory,
  type GitsHomePersistenceEntry,
  type GitsHomePersistenceKey,
} from './gits-persistence-registry.js'

export interface NodeGitsPersistenceOptions {
  readonly environment?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly runner?: SystemCommandRunner
  readonly uid?: number | null
  readonly userHome?: string
}

export class NodeGitsPersistence implements GitsPersistence {
  readonly #environment: NodeJS.ProcessEnv
  readonly #paths: GitsPaths
  readonly #platform: NodeJS.Platform
  readonly #runner: SystemCommandRunner
  readonly #uid: number | null
  readonly #userHome: string

  constructor(paths: GitsPaths, options: NodeGitsPersistenceOptions = {}) {
    this.#paths = paths
    this.#environment = options.environment ?? process.env
    this.#platform = options.platform ?? process.platform
    this.#runner = options.runner ?? new NodeSystemCommandRunner()
    this.#uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null)
    this.#userHome = options.userHome ?? homedir()
  }

  async inspect(): Promise<readonly GitsPersistenceTarget[]> {
    const external =
      this.#platform === 'darwin'
        ? this.discoverLaunchdProjections()
        : this.#platform === 'linux'
          ? this.discoverSystemdProjections()
          : Promise.resolve([])
    const [home, projections] = await Promise.all([this.inspectHome(), external])
    return [...home, ...projections].toSorted((left, right) => left.path.localeCompare(right.path))
  }

  async purge(signal?: AbortSignal): Promise<GitsPersistencePurgeResult> {
    signal?.throwIfAborted()
    await this.assertSafeDataRoot()
    const targets = await this.inspect()
    const external = targets.filter((target) => target.scope === 'external' && target.exists)
    const warnings: string[] = []
    const systemdTimers = external
      .filter((target) => target.id.startsWith('systemd:') && target.path.endsWith('.timer'))
      .map((target) => basename(target.path))

    if (this.#platform === 'darwin') {
      warnings.push(...(await this.stopLaunchdJobs(external)))
    } else if (this.#platform === 'linux') {
      warnings.push(...(await this.stopSystemdJobs(systemdTimers)))
    }

    await Promise.all(external.map((target) => rm(target.path, { force: true })))
    if (this.#platform === 'linux') {
      warnings.push(...(await this.reloadSystemdJobs(systemdTimers)))
    }
    const dataRootExists = await pathExists(this.#paths.home)
    if (dataRootExists) await rm(this.#paths.home, { force: true, recursive: true })
    return {
      removedPaths: [
        ...external.map((target) => target.path),
        ...(dataRootExists ? [this.#paths.home] : []),
      ],
      warnings,
    }
  }

  async inspectHome(): Promise<readonly GitsPersistenceTarget[]> {
    const dataRootExists = await pathExists(this.#paths.home)
    const entries = Object.entries(gitsHomePersistenceRegistry) as [
      GitsHomePersistenceKey,
      GitsHomePersistenceEntry,
    ][]
    const registered = await Promise.all(
      entries.map(async ([id, entry]): Promise<GitsPersistenceTarget> => ({
        description: entry.description,
        exists: await pathExists(this.#paths[id]),
        id,
        kind: entry.kind,
        path: this.#paths[id],
        scope: 'gits-home',
      })),
    )
    const stableRunner = gitsManagedArtifactRegistry.stableSchedulerRunner
    const stableRunnerPath = resolve(this.#paths[stableRunner.parent], stableRunner.fileName)
    const managedArtifacts: readonly GitsPersistenceTarget[] = [
      {
        description: stableRunner.description,
        exists: await pathExists(stableRunnerPath),
        id: 'stableSchedulerRunner',
        kind: 'file',
        path: stableRunnerPath,
        scope: 'gits-home',
      },
    ]
    const unknown = dataRootExists ? await this.unregisteredHomeEntries() : []
    return [
      {
        description: `${gitsPersistenceRootRegistry.description}; removed recursively`,
        exists: dataRootExists,
        id: 'gits-home',
        kind: 'data-root',
        path: this.#paths.home,
        scope: 'gits-home',
      },
      ...registered,
      ...managedArtifacts,
      ...unknown,
    ]
  }

  async unregisteredHomeEntries(): Promise<readonly GitsPersistenceTarget[]> {
    const known = registeredTopLevelNames()
    let entries: string[]
    try {
      entries = await readdir(this.#paths.home)
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return []
      throw error
    }
    return entries
      .filter((entry) => !known.has(entry))
      .map((entry) => ({
        description: 'Unregistered content below the exclusive gits data root',
        exists: true,
        id: `unregistered:${entry}`,
        kind: 'unregistered',
        path: resolve(this.#paths.home, entry),
        scope: 'gits-home',
      }))
  }

  async discoverLaunchdProjections(): Promise<readonly GitsPersistenceTarget[]> {
    const catalog = gitsExternalPersistenceRegistry.launchdRepoMirrorJobs
    const directory = resolveLaunchdProjectionDirectory(this.#userHome)
    const names = await matchingEntries(directory, catalog.filePrefix, [catalog.fileSuffix])
    const targets = await Promise.all(
      names.map(async (name): Promise<GitsPersistenceTarget | null> => {
        const path = resolve(directory, name)
        const content = await readOptional(path)
        if (content === null || !this.isOwnedLaunchdProjection(name, content)) return null
        return {
          description: catalog.description,
          exists: true,
          id: `launchd:${name}`,
          kind: 'native-projection',
          path,
          scope: 'external',
        }
      }),
    )
    return targets.filter((target): target is GitsPersistenceTarget => target !== null)
  }

  isOwnedLaunchdProjection(name: string, content: string): boolean {
    try {
      const value: unknown = parse(content)
      if (!isRecord(value)) return false
      const label = value.Label
      const environment = value.EnvironmentVariables
      const programArguments = value.ProgramArguments
      const expectedLabel = name.slice(
        0,
        -gitsExternalPersistenceRegistry.launchdRepoMirrorJobs.fileSuffix.length,
      )
      return (
        label === expectedLabel &&
        typeof label === 'string' &&
        label.startsWith(gitsExternalPersistenceRegistry.launchdRepoMirrorJobs.filePrefix) &&
        isRecord(environment) &&
        environment.GITS_HOME === this.#paths.home &&
        Array.isArray(programArguments) &&
        programArguments[0] === this.stableRunnerPath()
      )
    } catch {
      return false
    }
  }

  async discoverSystemdProjections(): Promise<readonly GitsPersistenceTarget[]> {
    const catalog = gitsExternalPersistenceRegistry.systemdRepoMirrorJobs
    const directory = resolveSystemdUserUnitDirectory(this.#environment, this.#userHome)
    const names = await matchingEntries(directory, catalog.filePrefix, catalog.fileSuffixes)
    const instanceKey = await this.installationKey()
    const instancePrefix = instanceKey === null ? null : `${catalog.filePrefix}${instanceKey}-`
    const files = await Promise.all(
      names.map(async (name) => ({ content: await readOptional(resolve(directory, name)), name })),
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
        if (file.content === null || !file.content.includes('X-Gits-Managed=true')) return false
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
        kind: 'native-projection',
        path: resolve(directory, file.name),
        scope: 'external',
      }))
    const enablementDirectory = resolveSystemdTimerEnablementDirectory(
      this.#environment,
      this.#userHome,
    )
    const enabledTimers = await matchingEntries(enablementDirectory, catalog.filePrefix, ['.timer'])
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
        kind: 'native-projection',
        path: resolve(enablementDirectory, name),
        scope: 'external',
      }))
    return [...units, ...enablements]
  }

  isOwnedSystemdService(name: string, content: string, instancePrefix: string | null): boolean {
    if (!content.includes('X-Gits-Managed=true')) return false
    if (instancePrefix !== null && name.startsWith(instancePrefix)) return true
    return (
      content.includes(`GITS_HOME=${escapeSystemdValue(this.#paths.home)}`) &&
      content.includes(gitsManagedArtifactRegistry.stableSchedulerRunner.fileName)
    )
  }

  async installationKey(): Promise<string | null> {
    const value = await readOptional(this.#paths.installationId)
    if (value === null || value.trim().length === 0) return null
    return createHash('sha256').update(value.trim()).digest('hex').slice(0, 12)
  }

  async assertSafeDataRoot(): Promise<void> {
    if (!(await pathExists(this.#paths.home))) return
    const root = parsePath(this.#paths.home).root
    const userHome = resolve(this.#userHome)
    const candidate = resolve(this.#paths.home)
    if (candidate === root || isEqualOrParent(candidate, userHome)) {
      throw new UninstallSafetyError(
        `Refusing to recursively remove unsafe GITS_HOME: ${candidate}`,
      )
    }

    const defaultHome = resolve(userHome, gitsPersistenceRootRegistry.defaultDirectoryName)
    if (candidate === defaultHome) return
    const installationId = await readOptional(this.#paths.installationId)
    if (installationId === null || !isUuid(installationId.trim())) {
      throw new UninstallSafetyError(
        `Refusing to remove custom GITS_HOME without a valid installation-id: ${candidate}`,
      )
    }
  }

  async stopLaunchdJobs(targets: readonly GitsPersistenceTarget[]): Promise<readonly string[]> {
    if (this.#uid === null) return ['Could not determine uid; LaunchAgent files were removed only.']
    const domain = `gui/${this.#uid}`
    const results = await Promise.all(
      targets
        .filter((item) => item.id.startsWith('launchd:'))
        .map(async (target): Promise<string | null> => {
          try {
            await this.#runner.run('/bin/launchctl', ['bootout', domain, target.path])
            const label = basename(target.path, '.plist')
            await this.#runner.run('/bin/launchctl', ['enable', `${domain}/${label}`])
            return null
          } catch (error) {
            return `Could not fully unload ${target.path}: ${errorMessage(error)}`
          }
        }),
    )
    return results.filter((result): result is string => result !== null)
  }

  async stopSystemdJobs(timers: readonly string[]): Promise<readonly string[]> {
    const warnings: string[] = []
    try {
      await Promise.all(
        timers.map((timer) => this.#runner.run('systemctl', ['--user', 'disable', '--now', timer])),
      )
    } catch (error) {
      warnings.push(`Could not fully unload systemd user jobs: ${errorMessage(error)}`)
    }
    return warnings
  }

  async reloadSystemdJobs(timers: readonly string[]): Promise<readonly string[]> {
    try {
      await this.#runner.run('systemctl', ['--user', 'daemon-reload'])
      await Promise.all(
        timers.map((timer) =>
          this.#runner.run('systemctl', ['--user', 'clean', '--what=state', timer]),
        ),
      )
      return []
    } catch (error) {
      return [`Could not reload the systemd user manager: ${errorMessage(error)}`]
    }
  }

  stableRunnerPath(): string {
    return resolve(this.#paths.bin, gitsManagedArtifactRegistry.stableSchedulerRunner.fileName)
  }
}

async function matchingEntries(
  directory: string,
  prefix: string,
  suffixes: readonly string[],
): Promise<readonly string[]> {
  try {
    return (await readdir(directory)).filter(
      (entry) => entry.startsWith(prefix) && suffixes.some((suffix) => entry.endsWith(suffix)),
    )
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return []
    throw error
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isEqualOrParent(candidate: string, target: string): boolean {
  const difference = relative(candidate, target)
  return difference === '' || (!difference.startsWith('..') && !parsePath(difference).root)
}

function isUuid(value: string): boolean {
  return /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu.test(value)
}

function escapeSystemdValue(value: string): string {
  return value.replace(/%/gu, '%%').replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
