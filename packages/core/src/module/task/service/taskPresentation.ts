import {
  ConcurrentTaskOutcomeStatus,
  RepositoryActionResult,
  type ConcurrentRunPresentation,
  type ConcurrentTaskOutcome,
  type RepositoryCommandResult,
  type TaskRepository,
} from '../../../contract/index'

export function repositoryTaskPresentation<T>(
  enabled: boolean,
  repositoryFor: (item: T) => TaskRepository,
  titlePrefix?: string,
): ConcurrentRunPresentation<T, RepositoryCommandResult> {
  return {
    enabled,
    outcome: repositoryTaskOutcome,
    title: (item) => {
      const name = repositoryFor(item).name
      return titlePrefix === undefined ? name : `${titlePrefix} ${name}`
    },
  }
}

function repositoryTaskOutcome(result: RepositoryCommandResult): ConcurrentTaskOutcome {
  if (result.result === RepositoryActionResult.Failed) {
    return {
      status: ConcurrentTaskOutcomeStatus.Failed,
      ...(result.error === null ? {} : { message: result.error.message }),
    }
  }
  if (result.result === RepositoryActionResult.NotRun) {
    return {
      status: ConcurrentTaskOutcomeStatus.Skipped,
      message: result.error?.message ?? 'not run before interruption',
    }
  }
  if (result.result === RepositoryActionResult.Skipped)
    return { status: ConcurrentTaskOutcomeStatus.Skipped, message: 'no changes required' }
  return { status: ConcurrentTaskOutcomeStatus.Completed }
}
