import { randomUUID } from 'node:crypto'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

import { RepoMirrorConfigurationError } from '../../domain/repo-mirror/errors.js'
import {
  gitsHomePersistenceRegistry,
  gitsPersistenceRootRegistry,
  resolveRegisteredGitsHomePath,
  type GitsHomePersistenceEntry,
  type GitsHomePersistenceKey,
} from '../persistence/gits-persistence-registry.js'

export type GitsPaths = Readonly<
  Record<GitsHomePersistenceKey, string> & {
    readonly home: string
  }
>

export interface ResolveGitsPathsOptions {
  readonly environment?: NodeJS.ProcessEnv
  readonly userHome?: string
}

export function resolveGitsPaths(options: ResolveGitsPathsOptions = {}): GitsPaths {
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

export async function ensureGitsLayout(paths: GitsPaths): Promise<void> {
  const directories = [paths.home, ...registeredDirectories(paths)]
  await Promise.all(directories.map((path) => mkdir(path, { mode: 0o700, recursive: true })))
  await Promise.all(directories.map((path) => chmod(path, 0o700)))
}

function registeredDirectories(paths: GitsPaths): readonly string[] {
  const entries = Object.entries(gitsHomePersistenceRegistry) as [
    GitsHomePersistenceKey,
    GitsHomePersistenceEntry,
  ][]
  return entries.filter(([, entry]) => entry.kind === 'directory').map(([key]) => paths[key])
}

export async function readOrCreateInstallationId(paths: GitsPaths): Promise<string> {
  await ensureGitsLayout(paths)
  try {
    const existing = (await readFile(paths.installationId, 'utf8')).trim()
    if (/^[0-9a-f-]{36}$/u.test(existing)) return existing
    throw new RepoMirrorConfigurationError('installation-id is invalid.')
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
  }

  const value = randomUUID()
  try {
    await writeFile(paths.installationId, `${value}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    return value
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error
    await access(paths.installationId)
    return (await readFile(paths.installationId, 'utf8')).trim()
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
