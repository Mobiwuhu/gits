import type { GitRepositoryGateway } from '../ports/git-repository-gateway.js'
import type { TaskConfigurationStore } from '../ports/task-configuration-store.js'
import { loadTaskConfiguration } from '../task/load-task-configuration.js'
import { isConflictState, withActionResult } from '../task/repository-result.js'
import { selectRepositories } from '../task/select-repositories.js'
import type { CommandOutput } from '../../domain/task/model.js'

export interface StatusTaskInput {
  readonly repositories: readonly string[]
  readonly root: string
  readonly signal?: AbortSignal
}

export interface StatusTaskDependencies {
  readonly configurationStore: TaskConfigurationStore
  readonly git: GitRepositoryGateway
}

export async function statusTask(
  dependencies: StatusTaskDependencies,
  input: StatusTaskInput,
): Promise<CommandOutput> {
  const configuration = await loadTaskConfiguration(
    dependencies.configurationStore,
    dependencies.git,
    { root: input.root, ...(input.signal ? { signal: input.signal } : {}) },
  )
  const repositories = selectRepositories(configuration, input.repositories)
  const results = await Promise.all(
    repositories.map(async (repository) =>
      withActionResult(
        await dependencies.git.inspect(repository, input.signal ? { signal: input.signal } : {}),
        'skipped',
      ),
    ),
  )

  return {
    command: 'status',
    ok: results.every(
      (result) =>
        result.result !== 'failed' &&
        !isConflictState(result.state) &&
        !result.flags.includes('checkout-different'),
    ),
    repos: results,
  }
}
