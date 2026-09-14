import { mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path'

import { Inject } from '@wendellhu/redi'

import {
  IFileSystemService,
  IGitsPathService,
  IRepoMirrorGitService,
  type IRepoMirrorDependencyService,
  type RepoMirrorDetachResult,
  type RepoMirrorDependencyState,
  type RepoMirrorDependent,
} from '../../../contract/index'

export class RepoMirrorDependencyService implements IRepoMirrorDependencyService {
  constructor(
    @Inject(IGitsPathService) private readonly paths: IGitsPathService,
    @Inject(IRepoMirrorGitService) private readonly git: IRepoMirrorGitService,
    @Inject(IFileSystemService) private readonly fileSystem: IFileSystemService,
  ) {}

  async register(
    mirrorName: string,
    mirrorPath: string,
    repositoryPath: string,
    recordedRepositoryPath: string = repositoryPath,
  ): Promise<boolean> {
    const gitDirectory = await this.git.resolveGitDirectory(repositoryPath)
    if (gitDirectory === null || !(await referencesMirror(gitDirectory, mirrorPath))) return false

    const [canonicalRepository, canonicalGitDirectory] = await Promise.all([
      canonicalPath(repositoryPath),
      canonicalPath(gitDirectory),
    ])
    const relativeGitDirectory = relative(canonicalRepository, canonicalGitDirectory)
    const recordedGitDirectory =
      relativeGitDirectory === '..' ||
      relativeGitDirectory.startsWith(`..${sep}`) ||
      isAbsolute(relativeGitDirectory)
        ? gitDirectory
        : resolve(recordedRepositoryPath, relativeGitDirectory)

    const current = await this.read(mirrorName)
    const withoutRepository = current.dependents.filter(
      (dependent) => normalize(dependent.gitDirectory) !== normalize(recordedGitDirectory),
    )
    const dependency: RepoMirrorDependent = {
      gitDirectory: recordedGitDirectory,
      registeredAt: new Date().toISOString(),
      repositoryPath: recordedRepositoryPath,
    }
    await this.write({
      dependents: [...withoutRepository, dependency],
      mirrorName,
      version: 1,
    })
    return true
  }

  async list(mirrorName: string, mirrorPath: string): Promise<readonly RepoMirrorDependent[]> {
    const current = await this.read(mirrorName)
    const live: RepoMirrorDependent[] = []
    for (const dependent of current.dependents) {
      if (await referencesMirror(dependent.gitDirectory, mirrorPath)) live.push(dependent)
    }
    return live
  }

  async detachAll(
    mirrorName: string,
    mirrorPath: string,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<RepoMirrorDetachResult> {
    const dependents = await this.list(mirrorName, mirrorPath)
    const detached: string[] = []
    const failures: { message: string; repositoryPath: string }[] = []

    for (const dependent of dependents) {
      if (options.signal?.aborted === true) {
        failures.push({
          message: 'Interrupted before repository could be detached.',
          repositoryPath: dependent.repositoryPath,
        })
        continue
      }
      const result = await this.detach(dependent, mirrorPath, options)
      if (result === null) detached.push(dependent.repositoryPath)
      else failures.push({ message: result, repositoryPath: dependent.repositoryPath })
    }

    if (failures.length === 0) {
      await this.write({ dependents: [], mirrorName, version: 1 })
    } else {
      await this.list(mirrorName, mirrorPath)
    }
    return { detached, failures }
  }

  private async detach(
    dependent: RepoMirrorDependent,
    mirrorPath: string,
    options: Readonly<{ signal?: AbortSignal }>,
  ): Promise<string | null> {
    const repack = await this.git.repackDependent(
      dependent.repositoryPath,
      options.signal === undefined ? {} : { signal: options.signal },
    )
    if (repack.aborted || repack.exitCode !== 0) return commandFailure('git repack', repack.stderr)

    const alternatesPath = resolve(dependent.gitDirectory, 'objects/info/alternates')
    let original: string
    try {
      original = await readFile(alternatesPath, 'utf8')
    } catch (error) {
      return hasCode(error, 'ENOENT')
        ? null
        : `Cannot read alternates: ${error instanceof Error ? error.message : String(error)}`
    }
    const filtered: string[] = []
    for (const line of original.split(/\r?\n/u)) {
      if (
        line.trim().length > 0 &&
        !(await isMirrorObjectsLine(line, alternatesPath, mirrorPath))
      ) {
        filtered.push(line)
      }
    }

    try {
      if (filtered.length === 0) await rm(alternatesPath, { force: true })
      else await this.fileSystem.writeFileAtomically(alternatesPath, `${filtered.join('\n')}\n`)
      const checked = await this.git.fsck(
        dependent.repositoryPath,
        options.signal === undefined ? {} : { signal: options.signal },
      )
      if (checked.aborted || checked.exitCode !== 0) {
        await this.fileSystem.writeFileAtomically(alternatesPath, original)
        return commandFailure('git fsck', checked.stderr)
      }
      return null
    } catch (error) {
      await this.fileSystem.writeFileAtomically(alternatesPath, original)
      return error instanceof Error ? error.message : String(error)
    }
  }

  private async read(mirrorName: string): Promise<RepoMirrorDependencyState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path(mirrorName), 'utf8'))
      if (!isDependencyState(parsed, mirrorName)) throw new Error('Dependency state is invalid.')
      return parsed
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return { dependents: [], mirrorName, version: 1 }
      throw error
    }
  }

  private async write(state: RepoMirrorDependencyState): Promise<void> {
    await mkdir(this.paths.dependencyState, { mode: 0o700, recursive: true })
    await this.fileSystem.writeFileAtomically(
      this.path(state.mirrorName),
      `${JSON.stringify(state, null, 2)}\n`,
    )
  }

  private path(mirrorName: string): string {
    return resolve(this.paths.dependencyState, `${mirrorName}.json`)
  }
}

async function referencesMirror(gitDirectory: string, mirrorPath: string): Promise<boolean> {
  const alternatesPath = resolve(gitDirectory, 'objects/info/alternates')
  try {
    const content = await readFile(alternatesPath, 'utf8')
    for (const line of content.split(/\r?\n/u)) {
      if (await isMirrorObjectsLine(line, alternatesPath, mirrorPath)) return true
    }
    return false
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false
    throw error
  }
}

async function isMirrorObjectsLine(
  line: string,
  alternatesPath: string,
  mirrorPath: string,
): Promise<boolean> {
  const value = line.trim()
  if (value.length === 0) return false
  const [alternateObjects, mirrorObjects] = await Promise.all([
    canonicalPath(resolve(dirname(dirname(alternatesPath)), value)),
    canonicalPath(resolve(mirrorPath, 'objects')),
  ])
  return alternateObjects === mirrorObjects
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return normalize(await realpath(path))
  } catch {
    return normalize(path)
  }
}

function isDependencyState(value: unknown, mirrorName: string): value is RepoMirrorDependencyState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('version' in value) || value.version !== 1) return false
  if (!('mirrorName' in value) || value.mirrorName !== mirrorName) return false
  if (!('dependents' in value) || !Array.isArray(value.dependents)) return false
  return value.dependents.every(
    (dependent) =>
      typeof dependent === 'object' &&
      dependent !== null &&
      'gitDirectory' in dependent &&
      typeof dependent.gitDirectory === 'string' &&
      'registeredAt' in dependent &&
      typeof dependent.registeredAt === 'string' &&
      'repositoryPath' in dependent &&
      typeof dependent.repositoryPath === 'string',
  )
}

function commandFailure(command: string, stderr: string): string {
  const message = stderr.trim()
  return message.length === 0 ? `${command} failed.` : `${command} failed: ${message}`
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
