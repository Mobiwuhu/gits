import {
  RepositoryActionResult,
  RepositoryState,
} from '../../../contract/index'
import type {
  CommandError,
  RepositoryCommandResult,
} from '../../../contract/index'

const conflictStates = new Set<RepositoryState>([
  RepositoryState.Missing,
  RepositoryState.NotGit,
  RepositoryState.WrongRepo,
  RepositoryState.Detached,
  RepositoryState.WrongBranch,
  RepositoryState.UpstreamGone,
  RepositoryState.WrongUpstream,
  RepositoryState.Diverged,
])

export function isConflictState(state: RepositoryState | null): boolean {
  return state !== null && conflictStates.has(state)
}

export function withActionResult(
  result: RepositoryCommandResult,
  action: RepositoryActionResult
): RepositoryCommandResult {
  return { ...result, result: action }
}

export function withCommandError(
  result: RepositoryCommandResult,
  error: CommandError,
  action: RepositoryActionResult = RepositoryActionResult.Failed
): RepositoryCommandResult {
  return { ...result, error, result: action }
}

export function commandError(code: string, message: string): CommandError {
  return { code, message }
}
