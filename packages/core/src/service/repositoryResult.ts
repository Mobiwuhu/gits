import { RepositoryActionResult } from '../contract/constants/index'
import type {
  ActualRepositoryState,
  ExpectedRepositoryState,
  RepositoryCommandResult,
  TaskRepository,
} from '../contract/types/index'

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
