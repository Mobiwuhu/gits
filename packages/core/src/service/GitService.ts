import { stat } from 'node:fs/promises'

import { Inject } from '@wendellhu/redi'

import {
  emptyActualState,
  expectedState,
  GitBranchPreparationKind,
  GitStdioMode,
  RepositoryActionResult,
  RepositoryFlag,
  RepositoryState,
  IGitCommandService,
} from '../contract/index'
import type {
  GitBranchPreparation,
  GitBranchPreparationOptions,
  GitCheckoutPathValidation,
  GitCloneOptions,
  GitCommandOptions,
  GitCommandResult,
  GitOperationOptions,
  GitPushOptions,
  GitReferenceLookup,
  GitStashResult,
  ActualRepositoryState,
  CommandError,
  RepositoryCommandResult,
  TaskRepository,
  IGitService,
} from '../contract/index'
import { compareGitUrls } from './gitUrl'

export type {
  GitBranchPreparation,
  GitBranchPreparationOptions,
  GitCheckoutPathValidation,
  GitCloneOptions,
  GitCommandResult,
  GitOperationOptions,
  GitPushOptions,
  GitReferenceLookup,
  GitStashResult,
} from '../contract/index'

enum PathState {
  Directory = 'directory',
  Missing = 'missing',
  NotDirectory = 'not-directory',
  Unavailable = 'unavailable',
}

export class GitService implements IGitService {
  constructor(
    @Inject(IGitCommandService) private readonly runner: IGitCommandService
  ) {}

  async applyCheckout(
    path: string,
    checkout: readonly string[] | null,
    options: GitOperationOptions = {}
  ): Promise<GitCommandResult> {
    return checkout === null
      ? this.runAction(path, ['sparse-checkout', 'disable'], options)
      : this.runAction(
          path,
          [
            'sparse-checkout',
            'set',
            '--cone',
            '--no-sparse-index',
            '--',
            ...checkout,
          ],
          options
        )
  }

  async checkRefFormat(
    branch: string,
    options: GitOperationOptions = {}
  ): Promise<GitCommandResult> {
    return this.runOutsideRepository(
      ['check-ref-format', '--branch', branch],
      options
    )
  }

  async clone(
    url: string,
    destination: string,
    options: GitCloneOptions = {}
  ): Promise<GitCommandResult> {
    const { reference } = options
    return this.runOutsideRepository(
      [
        'clone',
        '--origin',
        'origin',
        ...(options.noCheckout === true ? ['--no-checkout'] : []),
        ...(reference === undefined
          ? []
          : [
              '--reference-if-able',
              reference.path,
              ...(reference.dissociate ? ['--dissociate'] : []),
            ]),
        '--',
        url,
        destination,
      ],
      options
    )
  }

  async fetch(
    path: string,
    options: GitOperationOptions = {}
  ): Promise<GitCommandResult> {
    return this.runAction(path, ['fetch', 'origin', '--prune'], options)
  }

  async getRemoteUrl(
    path: string,
    remote = 'origin',
    options: GitOperationOptions = {}
  ): Promise<string | null> {
    const result = await this.runRead(
      path,
      ['remote', 'get-url', remote],
      options
    )
    return isSuccessful(result) ? nonEmptyTrimmed(result.stdout) : null
  }

  async hasRef(
    path: string,
    fullRef: string,
    options: GitOperationOptions = {}
  ): Promise<GitReferenceLookup> {
    const command = await this.runRead(
      path,
      ['show-ref', '--verify', '--quiet', fullRef],
      options
    )
    return { command, exists: isSuccessful(command) }
  }

  async inspect(
    repository: TaskRepository,
    options: GitOperationOptions = {}
  ): Promise<RepositoryCommandResult> {
    const pathState = await inspectPath(repository.absolutePath)
    if (pathState === PathState.Missing) {
      return repositoryResult(repository, RepositoryState.Missing)
    }
    if (pathState === PathState.NotDirectory) {
      return repositoryResult(repository, RepositoryState.NotGit)
    }
    if (pathState === PathState.Unavailable) {
      return repositoryFailure(repository, {
        code: 'repository-unavailable',
        message: `Cannot access repository path: ${repository.absolutePath}`,
      })
    }

    try {
      const worktree = await this.runRead(
        repository.absolutePath,
        ['rev-parse', '--is-inside-work-tree'],
        options
      )
      if (worktree.aborted) {
        return repositoryFailure(repository, toCommandError(worktree))
      }
      if (!isSuccessful(worktree) || worktree.stdout.trim() !== 'true') {
        return repositoryResult(repository, RepositoryState.NotGit)
      }

      const status = await this.runRead(
        repository.absolutePath,
        ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
        options
      )
      if (!isSuccessful(status)) {
        return repositoryFailure(repository, toCommandError(status))
      }

      const facts = parseStatus(status.stdout)
      const actualUrl = await this.getRemoteUrl(
        repository.absolutePath,
        'origin',
        options
      )
      const checkout = await this.readCheckout(repository.absolutePath, options)
      if (checkout.error !== null) {
        return repositoryFailure(repository, toCommandError(checkout.error))
      }
      const actual: ActualRepositoryState = {
        ahead: facts.ahead,
        behind: facts.behind,
        branch: facts.branch,
        checkout: checkout.paths,
        upstream: facts.upstream,
        url: actualUrl,
      }
      const comparison =
        actualUrl === null ? null : compareGitUrls(repository.url, actualUrl)
      const flags = repositoryFlags(
        checkout.isCone === false ||
          !sameCheckout(repository.checkout, checkout.paths),
        facts.dirty,
        comparison?.isTransportDifferent ?? false
      )

      if (comparison === null || !comparison.isSameRepository) {
        return repositoryResult(
          repository,
          RepositoryState.WrongRepo,
          actual,
          flags
        )
      }
      if (facts.branch === null) {
        return repositoryResult(
          repository,
          RepositoryState.Detached,
          actual,
          flags
        )
      }
      if (facts.branch !== repository.branch) {
        return repositoryResult(
          repository,
          RepositoryState.WrongBranch,
          actual,
          flags
        )
      }
      if (facts.upstream === null) {
        return repositoryResult(
          repository,
          RepositoryState.LocalOnly,
          actual,
          flags
        )
      }

      const remoteRef = remoteTrackingRef(facts.upstream)
      if (remoteRef === null) {
        return repositoryResult(
          repository,
          RepositoryState.WrongUpstream,
          actual,
          flags
        )
      }

      const upstreamReference = await this.hasRef(
        repository.absolutePath,
        remoteRef,
        options
      )
      if (
        upstreamReference.command.exitCode !== 0 &&
        upstreamReference.command.exitCode !== 1
      ) {
        return repositoryFailure(
          repository,
          toCommandError(upstreamReference.command),
          actual,
          flags
        )
      }
      if (!upstreamReference.exists) {
        return repositoryResult(
          repository,
          RepositoryState.UpstreamGone,
          actual,
          flags
        )
      }
      if (facts.upstream !== `origin/${repository.branch}`) {
        return repositoryResult(
          repository,
          RepositoryState.WrongUpstream,
          actual,
          flags
        )
      }

      const aheadBehind =
        facts.ahead === null || facts.behind === null
          ? await this.readAheadBehind(
              repository.absolutePath,
              facts.upstream,
              options
            )
          : { ahead: facts.ahead, behind: facts.behind }
      if (aheadBehind.ahead === null || aheadBehind.behind === null) {
        return repositoryFailure(
          repository,
          {
            code: 'git-status-unavailable',
            message: 'Unable to determine ahead/behind state.',
          },
          actual,
          flags
        )
      }
      const resolvedActual: ActualRepositoryState = {
        ...actual,
        ahead: aheadBehind.ahead,
        behind: aheadBehind.behind,
      }
      return repositoryResult(
        repository,
        stateFromAheadBehind(aheadBehind),
        resolvedActual,
        flags
      )
    } catch (error: unknown) {
      return repositoryFailure(repository, toUnexpectedCommandError(error))
    }
  }

  async prepareBranch(
    path: string,
    branch: GitBranchPreparationOptions,
    options: GitOperationOptions = {}
  ): Promise<GitBranchPreparation> {
    const commands: GitCommandResult[] = []
    const localBranch = await this.hasRef(
      path,
      `refs/heads/${branch.branch}`,
      options
    )
    commands.push(localBranch.command)
    if (isLookupFailure(localBranch)) {
      return { commands, kind: GitBranchPreparationKind.Failed }
    }

    if (localBranch.exists) {
      const command = await this.runAction(
        path,
        ['switch', branch.branch],
        options
      )
      commands.push(command)
      return {
        commands,
        kind: isSuccessful(command)
          ? GitBranchPreparationKind.ExistingLocal
          : GitBranchPreparationKind.Failed,
      }
    }

    if (branch.fetchIfMissing !== false) {
      const fetch = await this.fetch(path, options)
      commands.push(fetch)
      if (!isSuccessful(fetch)) {
        return { commands, kind: GitBranchPreparationKind.Failed }
      }
    }

    const remoteBranch = await this.hasRef(
      path,
      `refs/remotes/origin/${branch.branch}`,
      options
    )
    commands.push(remoteBranch.command)
    if (isLookupFailure(remoteBranch)) {
      return { commands, kind: GitBranchPreparationKind.Failed }
    }

    if (remoteBranch.exists) {
      const command = await this.runAction(
        path,
        ['switch', '-c', branch.branch, '--track', `origin/${branch.branch}`],
        options
      )
      commands.push(command)
      return {
        commands,
        kind: isSuccessful(command)
          ? GitBranchPreparationKind.TrackedRemote
          : GitBranchPreparationKind.Failed,
      }
    }

    const fromRef = remoteTrackingRef(branch.from)
    if (fromRef === null) {
      return { commands, kind: GitBranchPreparationKind.Failed }
    }
    const baseBranch = await this.hasRef(path, fromRef, options)
    commands.push(baseBranch.command)
    if (isLookupFailure(baseBranch) || !baseBranch.exists) {
      return { commands, kind: GitBranchPreparationKind.Failed }
    }

    const command = await this.runAction(
      path,
      ['switch', '--no-track', '-c', branch.branch, branch.from],
      options
    )
    commands.push(command)
    return {
      commands,
      kind: isSuccessful(command)
        ? GitBranchPreparationKind.CreatedFrom
        : GitBranchPreparationKind.Failed,
    }
  }

  async probeRemote(
    url: string,
    options: GitOperationOptions = {}
  ): Promise<GitCommandResult> {
    return this.runner.run(['ls-remote', '--symref', url, 'HEAD'], {
      cwd: process.cwd(),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
      interactive: options.interactive === true,
      stdio:
        options.interactive === true
          ? GitStdioMode.InteractivePipe
          : GitStdioMode.Pipe,
    })
  }

  async push(
    path: string,
    branch: string,
    options: GitPushOptions = {}
  ): Promise<GitCommandResult> {
    const args = ['push']
    if (options.dryRun === true) {
      args.push('--dry-run', 'origin', `${branch}:refs/heads/${branch}`)
    } else {
      args.push('-u', 'origin', `${branch}:refs/heads/${branch}`)
    }
    return this.runAction(path, args, options)
  }

  async stash(
    path: string,
    message: string,
    options: GitOperationOptions = {}
  ): Promise<GitStashResult> {
    const command = await this.runAction(
      path,
      ['stash', 'push', '--include-untracked', '-m', message],
      options
    )
    if (!isSuccessful(command)) {
      return { command, reference: null }
    }

    const reference = await this.runRead(
      path,
      ['rev-parse', '--verify', '--quiet', 'refs/stash'],
      options
    )
    return { command, reference: isSuccessful(reference) ? 'stash@{0}' : null }
  }

  async switchToBranch(
    path: string,
    branch: Omit<GitBranchPreparationOptions, 'fetchIfMissing'>,
    options: GitOperationOptions = {}
  ): Promise<GitBranchPreparation> {
    return this.prepareBranch(
      path,
      { ...branch, fetchIfMissing: true },
      options
    )
  }

  async validateCheckoutPaths(
    path: string,
    checkout: readonly string[],
    options: GitOperationOptions = {}
  ): Promise<GitCheckoutPathValidation> {
    const validations = await Promise.all(
      checkout.map(async (directory) => ({
        command: await this.runRead(
          path,
          [
            'ls-tree',
            '-d',
            '-z',
            '--name-only',
            'HEAD',
            '--',
            `:(literal)${directory}`,
          ],
          options
        ),
        directory,
      }))
    )

    return {
      commands: validations.map(({ command }) => command),
      missingPaths: validations.flatMap(({ command, directory }) => {
        if (!isSuccessful(command)) {
          return []
        }
        const matches = command.stdout
          .split('\0')
          .filter((entry) => entry.length > 0)
        return matches.includes(directory) ? [] : [directory]
      }),
    }
  }

  private async readAheadBehind(
    path: string,
    upstream: string,
    options: GitOperationOptions
  ): Promise<Readonly<{ ahead: number | null; behind: number | null }>> {
    const result = await this.runRead(
      path,
      ['rev-list', '--left-right', '--count', `HEAD...${upstream}`],
      options
    )
    if (!isSuccessful(result)) {
      return { ahead: null, behind: null }
    }
    return parseAheadBehind(result.stdout)
  }

  private async readCheckout(
    path: string,
    options: GitOperationOptions
  ): Promise<CheckoutInspection> {
    const enabled = await this.runRead(
      path,
      ['config', '--bool', '--get', 'core.sparseCheckout'],
      options
    )
    if (enabled.exitCode === 1 && !enabled.aborted) {
      return { error: null, isCone: null, paths: null }
    }
    if (!isSuccessful(enabled)) {
      return { error: enabled, isCone: null, paths: null }
    }
    if (enabled.stdout.trim() !== 'true') {
      return { error: null, isCone: null, paths: null }
    }

    const cone = await this.runRead(
      path,
      ['config', '--bool', '--get', 'core.sparseCheckoutCone'],
      options
    )
    if (cone.exitCode !== 0 && cone.exitCode !== 1) {
      return { error: cone, isCone: null, paths: null }
    }

    const listed = await this.runRead(
      path,
      ['sparse-checkout', 'list'],
      options
    )
    if (!isSuccessful(listed)) {
      return { error: listed, isCone: null, paths: null }
    }

    return {
      error: null,
      isCone: cone.exitCode === 0 && cone.stdout.trim() === 'true',
      paths: listed.stdout
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    }
  }

  private async runAction(
    path: string,
    args: readonly string[],
    options: GitOperationOptions
  ): Promise<GitCommandResult> {
    return this.runner.run(
      args,
      commandOptions(path, options, options.interactive === true)
    )
  }

  private async runOutsideRepository(
    args: readonly string[],
    options: GitOperationOptions
  ): Promise<GitCommandResult> {
    return this.runner.run(
      args,
      commandOptions(process.cwd(), options, options.interactive === true)
    )
  }

  private async runRead(
    path: string,
    args: readonly string[],
    options: GitOperationOptions
  ): Promise<GitCommandResult> {
    return this.runner.run(args, commandOptions(path, options, false))
  }
}

export function isSuccessful(result: GitCommandResult): boolean {
  return !result.aborted && result.exitCode === 0
}

export function toCommandError(result: GitCommandResult): CommandError {
  const output =
    nonEmptyTrimmed(result.stderr) ?? nonEmptyTrimmed(result.stdout)
  let outcome = `exited with code ${result.exitCode}`
  if (result.exitCode === null) {
    outcome = 'did not return an exit code'
  }
  if (result.aborted) {
    outcome = 'was interrupted'
  }
  return {
    code: result.aborted ? 'interrupted' : 'git-command-failed',
    message: output ?? `git ${result.args.join(' ')} ${outcome}`,
  }
}

type ParsedStatus = Readonly<{
  ahead: number | null
  behind: number | null
  branch: string | null
  dirty: boolean
  upstream: string | null
}>

type CheckoutInspection = Readonly<{
  error: GitCommandResult | null
  isCone: boolean | null
  paths: readonly string[] | null
}>

async function inspectPath(path: string): Promise<PathState> {
  try {
    const metadata = await stat(path)
    return metadata.isDirectory() ? PathState.Directory : PathState.NotDirectory
  } catch (error: unknown) {
    return hasCode(error, 'ENOENT') ? PathState.Missing : PathState.Unavailable
  }
}

function commandOptions(
  cwd: string,
  options: GitOperationOptions,
  inheritStdio: boolean
): GitCommandOptions {
  const stdio =
    options.onOutput === undefined
      ? GitStdioMode.Inherit
      : GitStdioMode.InteractivePipe
  return {
    cwd,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
    ...(inheritStdio
      ? {
          interactive: true,
          stdio,
        }
      : {}),
  }
}

function parseStatus(output: string): ParsedStatus {
  let branch: string | null = null
  let upstream: string | null = null
  let ahead: number | null = null
  let behind: number | null = null
  let dirty = false

  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length)
      branch = value.startsWith('(') ? null : value
      continue
    }
    if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length)
      continue
    }
    if (line.startsWith('# branch.ab ')) {
      ;({ ahead, behind } = parseAheadBehind(line.slice('# branch.ab '.length)))
      continue
    }
    if (line.length > 0 && !line.startsWith('# ')) {
      dirty = true
    }
  }

  return { ahead, behind, branch, dirty, upstream }
}

function parseAheadBehind(
  output: string
): Readonly<{ ahead: number | null; behind: number | null }> {
  const matches = /^\+?(?<ahead>\d+)\s+-?(?<behind>\d+)$/u.exec(output.trim())
  const aheadText = matches?.groups?.ahead
  const behindText = matches?.groups?.behind
  if (aheadText === undefined || behindText === undefined) {
    return { ahead: null, behind: null }
  }

  const ahead = Math.trunc(Number(aheadText))
  const behind = Math.trunc(Number(behindText))
  return Number.isSafeInteger(ahead) && Number.isSafeInteger(behind)
    ? { ahead, behind }
    : { ahead: null, behind: null }
}

function repositoryFlags(
  checkoutDifferent: boolean,
  dirty: boolean,
  urlDifferent: boolean
): readonly RepositoryFlag[] {
  return [
    ...(checkoutDifferent ? [RepositoryFlag.CheckoutDifferent] : []),
    ...(dirty ? [RepositoryFlag.Dirty] : []),
    ...(urlDifferent ? [RepositoryFlag.UrlDifferent] : []),
  ]
}

function sameCheckout(
  expected: readonly string[] | null,
  actual: readonly string[] | null
): boolean {
  if (expected === null || actual === null) {
    return expected === actual
  }
  if (expected.length !== actual.length) {
    return false
  }

  const expectedPaths = expected.toSorted()
  const actualPaths = actual.toSorted()
  return expectedPaths.every((path, index) => path === actualPaths[index])
}

function repositoryResult(
  repository: TaskRepository,
  state: RepositoryState,
  actual: ActualRepositoryState = emptyActualState(),
  flags: readonly RepositoryFlag[] = []
): RepositoryCommandResult {
  return {
    actual,
    error: null,
    expected: expectedState(repository),
    flags,
    name: repository.name,
    path: repository.path,
    result: RepositoryActionResult.Success,
    state,
  }
}

function repositoryFailure(
  repository: TaskRepository,
  error: CommandError,
  actual: ActualRepositoryState = emptyActualState(),
  flags: readonly RepositoryFlag[] = []
): RepositoryCommandResult {
  return {
    actual,
    error,
    expected: expectedState(repository),
    flags,
    name: repository.name,
    path: repository.path,
    result: RepositoryActionResult.Failed,
    state: null,
  }
}

function stateFromAheadBehind(
  counts: Readonly<{ ahead: number | null; behind: number | null }>
): RepositoryState {
  if (counts.ahead === null || counts.behind === null) {
    return RepositoryState.SyncedLocal
  }
  if (counts.ahead > 0 && counts.behind > 0) {
    return RepositoryState.Diverged
  }
  if (counts.ahead > 0) {
    return RepositoryState.Ahead
  }
  if (counts.behind > 0) {
    return RepositoryState.Behind
  }
  return RepositoryState.SyncedLocal
}

function remoteTrackingRef(upstream: string): string | null {
  const separator = upstream.indexOf('/')
  if (separator < 1 || separator === upstream.length - 1) {
    return null
  }
  return `refs/remotes/${upstream}`
}

function isLookupFailure(lookup: GitReferenceLookup): boolean {
  return lookup.command.exitCode !== 0 && lookup.command.exitCode !== 1
}

function nonEmptyTrimmed(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function toUnexpectedCommandError(error: unknown): CommandError {
  return {
    code: 'git-command-failed',
    message:
      error instanceof Error
        ? error.message
        : 'Git command failed unexpectedly',
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  )
}
