import type {
  CommandError,
  RepositoryActionResult,
  RepositoryCommandResult,
  RepositoryState,
} from '../../domain/task/model.js'

const conflictStates = new Set<RepositoryState>([
  'missing',
  'not-git',
  'wrong-repo',
  'detached',
  'wrong-branch',
  'upstream-gone',
  'wrong-upstream',
  'diverged',
])

export function isConflictState(state: RepositoryState | null): boolean {
  return state !== null && conflictStates.has(state)
}

export function withActionResult(
  result: RepositoryCommandResult,
  action: RepositoryActionResult,
): RepositoryCommandResult {
  return { ...result, result: action }
}

export function withCommandError(
  result: RepositoryCommandResult,
  error: CommandError,
  action: RepositoryActionResult = 'failed',
): RepositoryCommandResult {
  return { ...result, error, result: action }
}

export function commandError(code: string, message: string): CommandError {
  return { code, message }
}
