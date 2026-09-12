import type { RepositoryCommandResult, TaskRepository } from '../../domain/task/model.js'

export type GitOutputChunk = Readonly<{
  stream: 'stderr' | 'stdout'
  text: string
}>

export type GitCommandResult = Readonly<{
  aborted: boolean
  args: readonly string[]
  durationMs: number
  exitCode: number | null
  signal: NodeJS.Signals | null
  stderr: string
  stdout: string
}>

export type GitOperationOptions = Readonly<{
  interactive?: boolean
  onOutput?: (chunk: GitOutputChunk) => void
  signal?: AbortSignal
}>

export type GitCloneOptions = GitOperationOptions &
  Readonly<{
    noCheckout?: boolean
    reference?: Readonly<{
      dissociate: boolean
      ifAble: true
      path: string
    }>
  }>

export type GitCheckoutPathValidation = Readonly<{
  commands: readonly GitCommandResult[]
  missingPaths: readonly string[]
}>

export type GitReferenceLookup = Readonly<{
  command: GitCommandResult
  exists: boolean
}>

export type GitBranchPreparationOptions = Readonly<{
  branch: string
  fetchIfMissing?: boolean
  from: string
}>

export type GitBranchPreparation = Readonly<{
  commands: readonly GitCommandResult[]
  kind: 'created-from' | 'existing-local' | 'failed' | 'tracked-remote'
}>

export type GitStashResult = Readonly<{
  command: GitCommandResult
  reference: string | null
}>

export type GitPushOptions = GitOperationOptions &
  Readonly<{
    dryRun?: boolean
  }>

/**
 * Application-facing port for interacting with a local Git working tree.
 * Implementations must preserve the native Git repository as the source of
 * runtime state and leave orchestration decisions to use cases.
 */
export interface GitRepositoryGateway {
  applyCheckout(
    path: string,
    checkout: readonly string[] | null,
    options?: GitOperationOptions,
  ): Promise<GitCommandResult>
  checkRefFormat(branch: string, options?: GitOperationOptions): Promise<GitCommandResult>
  clone(url: string, destination: string, options?: GitCloneOptions): Promise<GitCommandResult>
  fetch(path: string, options?: GitOperationOptions): Promise<GitCommandResult>
  getRemoteUrl(path: string, remote?: string, options?: GitOperationOptions): Promise<string | null>
  hasRef(path: string, fullRef: string, options?: GitOperationOptions): Promise<GitReferenceLookup>
  inspect(
    repository: TaskRepository,
    options?: GitOperationOptions,
  ): Promise<RepositoryCommandResult>
  prepareBranch(
    path: string,
    branch: GitBranchPreparationOptions,
    options?: GitOperationOptions,
  ): Promise<GitBranchPreparation>
  probeRemote(url: string, options?: GitOperationOptions): Promise<GitCommandResult>
  push(path: string, branch: string, options?: GitPushOptions): Promise<GitCommandResult>
  stash(path: string, message: string, options?: GitOperationOptions): Promise<GitStashResult>
  switchToBranch(
    path: string,
    branch: Omit<GitBranchPreparationOptions, 'fetchIfMissing'>,
    options?: GitOperationOptions,
  ): Promise<GitBranchPreparation>
  validateCheckoutPaths(
    path: string,
    checkout: readonly string[],
    options?: GitOperationOptions,
  ): Promise<GitCheckoutPathValidation>
}
