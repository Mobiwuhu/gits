import type { TaskRepository } from './task'

export enum RepositoryState {
  Missing = 'missing',
  NotGit = 'not-git',
  WrongRepo = 'wrong-repo',
  Detached = 'detached',
  WrongBranch = 'wrong-branch',
  UpstreamGone = 'upstream-gone',
  WrongUpstream = 'wrong-upstream',
  LocalOnly = 'local-only',
  Diverged = 'diverged',
  Ahead = 'ahead',
  Behind = 'behind',
  SyncedLocal = 'synced-local',
}

export const repositoryStates: readonly RepositoryState[] =
  Object.values(RepositoryState)

export enum RepositoryFlag {
  CheckoutDifferent = 'checkout-different',
  Dirty = 'dirty',
  UrlDifferent = 'url-different',
}

export const repositoryFlags: readonly RepositoryFlag[] =
  Object.values(RepositoryFlag)

export enum RepositoryActionResult {
  Success = 'success',
  Skipped = 'skipped',
  Failed = 'failed',
  NotRun = 'not-run',
}

export interface ExpectedRepositoryState {
  readonly url: string
  readonly branch: string
  readonly checkout: readonly string[] | null
  readonly upstream: string
}

export interface ActualRepositoryState {
  readonly url: string | null
  readonly branch: string | null
  readonly checkout: readonly string[] | null
  readonly upstream: string | null
  readonly ahead: number | null
  readonly behind: number | null
}

export interface CommandError {
  readonly code: string
  readonly message: string
}

export interface RepositoryCommandResult {
  readonly actual: ActualRepositoryState
  readonly error: CommandError | null
  readonly expected: ExpectedRepositoryState
  readonly flags: readonly RepositoryFlag[]
  readonly name: string
  readonly mirror?: Readonly<{
    readonly dissociated: boolean
    readonly name: string
    readonly path: string
  }>
  readonly mirrorFallbackReason?: string
  readonly path: string
  readonly result: RepositoryActionResult
  readonly state: RepositoryState | null
}

export interface CommandOutput {
  readonly command: string
  readonly ok: boolean
  readonly repos: readonly RepositoryCommandResult[]
}

export function expectedState(
  repository: TaskRepository
): ExpectedRepositoryState {
  return {
    branch: repository.branch,
    checkout: repository.checkout,
    upstream: `origin/${repository.branch}`,
    url: repository.url,
  }
}

export function emptyActualState(): ActualRepositoryState {
  return {
    ahead: null,
    behind: null,
    branch: null,
    checkout: null,
    upstream: null,
    url: null,
  }
}

export function initialRepositoryResult(
  repository: TaskRepository
): RepositoryCommandResult {
  return {
    actual: emptyActualState(),
    error: null,
    expected: expectedState(repository),
    flags: [],
    name: repository.name,
    path: repository.path,
    result: RepositoryActionResult.NotRun,
    state: null,
  }
}
