import type {
  ConcurrentRunPresentation,
  ConcurrentTaskOutcome,
} from '../../infrastructure/concurrency/concurrent-runner.js'
import type { RepositoryCommandResult, TaskRepository } from '../../domain/task/model.js'

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
  if (result.result === 'failed') {
    return {
      status: 'failed',
      ...(result.error === null ? {} : { message: result.error.message }),
    }
  }
  if (result.result === 'not-run') {
    return {
      status: 'skipped',
      message: result.error?.message ?? 'not run before interruption',
    }
  }
  if (result.result === 'skipped') return { status: 'skipped', message: 'no changes required' }
  return { status: 'completed' }
}
