import type {
  RepositoryActionResult,
  RepositoryFlag,
  RepositoryState,
} from '../constants/commandResult'

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
  readonly expected: ExpectedRepositoryState | null
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
