import type {
  GitBranchPreparationKind,
  GitOutputStream,
  GitStdioMode,
} from '../constants/git'
import type { RepositoryCommandResult } from './commandResult'
import type { RepositoryLocation } from './task'

export type GitOutputChunk = Readonly<{
  stream: GitOutputStream
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
  kind: GitBranchPreparationKind
}>

export type GitStashResult = Readonly<{
  command: GitCommandResult
  reference: string | null
}>

export type GitPushOptions = GitOperationOptions &
  Readonly<{
    dryRun?: boolean
  }>

export type GitCommandOptions = Readonly<{
  cwd: string
  environment?: NodeJS.ProcessEnv
  interactive?: boolean
  onOutput?: (chunk: GitOutputChunk) => void
  signal?: AbortSignal
  stdio?: GitStdioMode
}>

export type GitInspectInput = Readonly<{
  options?: GitOperationOptions
  repository: RepositoryLocation
}>

export type GitInspectOutput = RepositoryCommandResult
