import {
  ConcurrentTaskOutcomeStatus,
  RepositoryActionResult,
} from '../../../contract/index'
import type {
  ConcurrentRunPresentation,
  ConcurrentTaskOutcome,
  RepositoryCommandResult,
  TaskRepository,
} from '../../../contract/index'

export function repositoryTaskPresentation<T>(
  enabled: boolean,
  repositoryFor: (item: T) => TaskRepository,
  titlePrefix?: string
): ConcurrentRunPresentation<T, RepositoryCommandResult> {
  return {
    enabled,
    outcome: repositoryTaskOutcome,
    title: (item) => {
      const { name } = repositoryFor(item)
      return titlePrefix === undefined ? name : `${titlePrefix} ${name}`
    },
  }
}

function repositoryTaskOutcome(
  result: RepositoryCommandResult
): ConcurrentTaskOutcome {
  if (result.result === RepositoryActionResult.Failed) {
    return {
      status: ConcurrentTaskOutcomeStatus.Failed,
      ...(result.error === null ? {} : { message: result.error.message }),
    }
  }
  if (result.result === RepositoryActionResult.NotRun) {
    return {
      message: result.error?.message ?? 'not run before interruption',
      status: ConcurrentTaskOutcomeStatus.Skipped,
    }
  }
  if (result.result === RepositoryActionResult.Skipped) {
    return {
      message: 'no changes required',
      status: ConcurrentTaskOutcomeStatus.Skipped,
    }
  }
  return { status: ConcurrentTaskOutcomeStatus.Completed }
}
