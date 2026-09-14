import { randomUUID } from 'node:crypto'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

import {
  GitsPersistenceTargetKind,
  RepoMirrorConfigurationError,
  type GitsPaths,
  type IGitsPathService,
  type ResolveGitsPathsOptions,
} from '../contract/index'
import {
  gitsHomePersistenceRegistry,
  gitsPersistenceRootRegistry,
  resolveRegisteredGitsHomePath,
  type GitsHomePersistenceEntry,
  type GitsHomePersistenceKey,
} from './gitsPersistenceRegistry'

export class GitsPathService implements IGitsPathService {
  readonly bin: string
  readonly config: string
  readonly dependencyState: string
  readonly home: string
  readonly installationId: string
  readonly locks: string
  readonly logs: string
  readonly mirrors: string
  readonly mirrorState: string
  readonly operations: string
  readonly state: string
  readonly temporary: string
  readonly trash: string

  constructor(options: ResolveGitsPathsOptions = {}) {
    const paths = this.resolvePaths(options)
    this.bin = paths.bin
    this.config = paths.config
    this.dependencyState = paths.dependencyState
    this.home = paths.home
    this.installationId = paths.installationId
    this.locks = paths.locks
    this.logs = paths.logs
    this.mirrors = paths.mirrors
    this.mirrorState = paths.mirrorState
    this.operations = paths.operations
    this.state = paths.state
    this.temporary = paths.temporary
    this.trash = paths.trash
  }

  async ensureLayout(): Promise<void> {
    const directories = [this.home, ...this.registeredDirectories()]
    await Promise.all(directories.map((path) => mkdir(path, { mode: 0o700, recursive: true })))
    await Promise.all(directories.map((path) => chmod(path, 0o700)))
  }

  async readOrCreateInstallationId(): Promise<string> {
    await this.ensureLayout()
    try {
      const existing = (await readFile(this.installationId, 'utf8')).trim()
      if (/^[0-9a-f-]{36}$/u.test(existing)) return existing
      throw new RepoMirrorConfigurationError('installation-id is invalid.')
    } catch (error) {
      if (!this.hasCode(error, 'ENOENT')) throw error
    }

    const value = randomUUID()
    try {
      await writeFile(this.installationId, `${value}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      return value
    } catch (error) {
      if (!this.hasCode(error, 'EEXIST')) throw error
      await access(this.installationId)
      return (await readFile(this.installationId, 'utf8')).trim()
    }
  }

  private resolvePaths(options: ResolveGitsPathsOptions): GitsPaths {
    const environment = options.environment ?? process.env
    const configured = environment.GITS_HOME
    if (configured !== undefined && !isAbsolute(configured)) {
      throw new RepoMirrorConfigurationError('GITS_HOME must be an absolute path.')
    }

    const home = resolve(
      configured ??
        resolve(options.userHome ?? homedir(), gitsPersistenceRootRegistry.defaultDirectoryName),
    )
    const entries = Object.keys(gitsHomePersistenceRegistry) as GitsHomePersistenceKey[]
    const registered = Object.fromEntries(
      entries.map((key) => [key, resolveRegisteredGitsHomePath(home, key)]),
    ) as Record<GitsHomePersistenceKey, string>
    return { home, ...registered }
  }

  private registeredDirectories(): readonly string[] {
    const entries = Object.entries(gitsHomePersistenceRegistry) as [
      GitsHomePersistenceKey,
      GitsHomePersistenceEntry,
    ][]
    return entries
      .filter(([, entry]) => entry.kind === GitsPersistenceTargetKind.Directory)
      .map(([key]) => this[key])
  }

  private hasCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code
  }
}
