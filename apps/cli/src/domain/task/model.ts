export const repositoryStates = [
  'missing',
  'not-git',
  'wrong-repo',
  'detached',
  'wrong-branch',
  'upstream-gone',
  'wrong-upstream',
  'local-only',
  'diverged',
  'ahead',
  'behind',
  'synced-local',
] as const

export type RepositoryState = (typeof repositoryStates)[number]

export const repositoryFlags = ['checkout-different', 'dirty', 'url-different'] as const

export type RepositoryFlag = (typeof repositoryFlags)[number]

export type RepositoryActionResult = 'success' | 'skipped' | 'failed' | 'not-run'

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

export interface TaskRepository {
  readonly absolutePath: string
  readonly branch: string
  readonly checkout: readonly string[] | null
  readonly dissociate: boolean
  readonly from: string
  readonly name: string
  readonly path: string
  readonly url: string
}

export interface TaskConfiguration {
  readonly configPath: string
  readonly repositories: readonly TaskRepository[]
  readonly root: string
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

export function expectedState(repository: TaskRepository): ExpectedRepositoryState {
  return {
    url: repository.url,
    branch: repository.branch,
    checkout: repository.checkout,
    upstream: `origin/${repository.branch}`,
  }
}

export function emptyActualState(): ActualRepositoryState {
  return {
    url: null,
    branch: null,
    checkout: null,
    upstream: null,
    ahead: null,
    behind: null,
  }
}

export function initialRepositoryResult(repository: TaskRepository): RepositoryCommandResult {
  return {
    name: repository.name,
    path: repository.path,
    result: 'not-run',
    state: null,
    flags: [],
    expected: expectedState(repository),
    actual: emptyActualState(),
    error: null,
  }
}

export function isRepositoryIncomplete(repository: TaskRepository): boolean {
  return [
    repository.url,
    repository.branch,
    repository.from,
    repository.path,
    ...(repository.checkout ?? []),
  ].some((value) => /<[^>]+>/.test(value))
}
