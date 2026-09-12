import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import type {
  RepoMirrorGateway,
  RepoMirrorGitOperation,
} from '../../application/ports/repo-mirror-gateway.js'
import type {
  GitCommandResult,
  GitOperationOptions,
} from '../../application/ports/git-repository-gateway.js'
import { compareGitUrls } from '../../domain/git/remote-url.js'
import type { RepoMirrorDefinition, RepoMirrorHealth } from '../../domain/repo-mirror/model.js'
import {
  createGitCommandRunner,
  type GitCommandOptions,
  type GitCommandRunner,
} from '../git/git-command-runner.js'

const mirrorFetchRefspec = '+refs/*:refs/*'

export class GitRepoMirrorGateway implements RepoMirrorGateway {
  readonly #runner: GitCommandRunner

  constructor(runner: GitCommandRunner = createGitCommandRunner()) {
    this.#runner = runner
  }

  async cloneMirror(
    url: string,
    destination: string,
    options: GitOperationOptions = {},
  ): Promise<RepoMirrorGitOperation> {
    const commands: GitCommandResult[] = []
    commands.push(await this.runOutside(['clone', '--mirror', '--', url, destination], options))
    if (!isSuccessful(commands.at(-1))) return { commands, ok: false }

    for (const [key, value] of [
      ['gits.repoMirror.managed', 'true'],
      ['remote.origin.mirror', 'true'],
      ['remote.origin.fetch', mirrorFetchRefspec],
      ['maintenance.auto', 'false'],
      ['gc.auto', '0'],
      ['gc.autoDetach', 'false'],
    ] as const) {
      const command = await this.run(destination, ['config', key, value], options)
      commands.push(command)
      if (!isSuccessful(command)) return { commands, ok: false }
    }
    return { commands, ok: true }
  }

  async fetchMirror(
    path: string,
    options: GitOperationOptions = {},
  ): Promise<RepoMirrorGitOperation> {
    const command = await this.run(
      path,
      [
        '-c',
        'maintenance.auto=false',
        '-c',
        'gc.auto=0',
        'fetch',
        '--prune',
        '--no-auto-maintenance',
        'origin',
      ],
      options,
    )
    return { commands: [command], ok: isSuccessful(command) }
  }

  fsck(path: string, options: GitOperationOptions = {}): Promise<GitCommandResult> {
    return this.run(path, ['fsck', '--full', '--no-dangling'], options)
  }

  async inspect(definition: RepoMirrorDefinition, path: string): Promise<RepoMirrorHealth> {
    try {
      const metadata = await stat(path)
      if (!metadata.isDirectory()) return invalidHealth('Mirror path is not a directory.')
    } catch (error) {
      return hasCode(error, 'ENOENT')
        ? { issues: ['Mirror directory does not exist.'], state: 'missing' }
        : invalidHealth(error instanceof Error ? error.message : String(error))
    }

    const issues: string[] = []
    const bare = await this.runRead(path, ['rev-parse', '--is-bare-repository'])
    if (!isSuccessful(bare) || bare.stdout.trim() !== 'true') {
      issues.push('Repository is not bare.')
    }
    const managed = await this.readConfig(path, 'gits.repoMirror.managed')
    if (managed !== 'true') issues.push('Managed marker is missing.')
    const mirror = await this.readConfig(path, 'remote.origin.mirror')
    if (mirror !== 'true') issues.push('remote.origin.mirror is not true.')
    const refspec = await this.readConfig(path, 'remote.origin.fetch')
    if (refspec !== mirrorFetchRefspec) issues.push('Mirror fetch refspec is invalid.')
    const origin = await this.readConfig(path, 'remote.origin.url')
    if (origin === null || !sameRepositoryUrl(definition.urls[0], origin)) {
      issues.push('origin URL does not match the active fetch URL.')
    }
    try {
      const alternates = (await readFile(resolve(path, 'objects/info/alternates'), 'utf8')).trim()
      if (alternates.length > 0)
        issues.push('Managed mirror must not borrow objects via alternates.')
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) {
        issues.push(
          `Cannot inspect mirror alternates: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return { issues, state: issues.length === 0 ? 'ready' : 'invalid' }
  }

  async isManagedMirror(path: string): Promise<boolean> {
    return (await this.readConfig(path, 'gits.repoMirror.managed')) === 'true'
  }

  maintainMirror(path: string, options: GitOperationOptions = {}): Promise<GitCommandResult> {
    return this.run(path, ['gc', '--prune=30.days.ago'], options)
  }

  probeRemote(url: string, options: GitOperationOptions = {}): Promise<GitCommandResult> {
    return this.runOutside(['ls-remote', '--symref', url, 'HEAD'], options)
  }

  repackDependent(path: string, options: GitOperationOptions = {}): Promise<GitCommandResult> {
    return this.run(path, ['repack', '-a', '-d'], options)
  }

  async resolveGitDirectory(
    path: string,
    options: GitOperationOptions = {},
  ): Promise<string | null> {
    const command = await this.run(
      path,
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      options,
    )
    return isSuccessful(command) ? nonEmpty(command.stdout) : null
  }

  async resolveRemoteUrl(url: string, options: GitOperationOptions = {}): Promise<string | null> {
    const command = await this.runOutside(['ls-remote', '--get-url', url], options)
    return isSuccessful(command) ? nonEmpty(command.stdout) : null
  }

  async setFetchUrl(
    path: string,
    url: string,
    options: GitOperationOptions = {},
  ): Promise<RepoMirrorGitOperation> {
    const commands: GitCommandResult[] = []
    const remote = await this.run(path, ['remote', 'set-url', 'origin', url], options)
    commands.push(remote)
    if (!isSuccessful(remote)) return { commands, ok: false }
    const marker = await this.run(path, ['config', 'remote.origin.mirror', 'true'], options)
    commands.push(marker)
    return { commands, ok: isSuccessful(marker) }
  }

  async readConfig(path: string, key: string): Promise<string | null> {
    const command = await this.runRead(path, ['config', '--get', key])
    return isSuccessful(command) ? nonEmpty(command.stdout) : null
  }

  run(
    path: string,
    args: readonly string[],
    options: GitOperationOptions,
  ): Promise<GitCommandResult> {
    return this.#runner.run(args, commandOptions(path, options))
  }

  runOutside(args: readonly string[], options: GitOperationOptions): Promise<GitCommandResult> {
    return this.#runner.run(args, commandOptions(process.cwd(), options))
  }

  runRead(path: string, args: readonly string[]): Promise<GitCommandResult> {
    return this.#runner.run(args, { cwd: path })
  }
}

function commandOptions(cwd: string, options: GitOperationOptions): GitCommandOptions {
  return {
    cwd,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
    ...(options.interactive === true
      ? { interactive: true, stdio: 'interactive-pipe' as const }
      : {}),
  }
}

function isSuccessful(result: GitCommandResult | undefined): boolean {
  return result !== undefined && !result.aborted && result.exitCode === 0
}

function sameRepositoryUrl(expected: string, actual: string): boolean {
  if (expected.trim() === actual.trim()) return true
  return compareGitUrls(expected, actual).isSameRepository
}

function invalidHealth(issue: string): RepoMirrorHealth {
  return { issues: [issue], state: 'invalid' }
}

function nonEmpty(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
