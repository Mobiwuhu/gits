import type { GitOperationOptions, GitRepositoryGateway } from '../ports/git-repository-gateway.js'
import { reportProgress, type RepositoryProgressReporter } from '../ports/progress-reporter.js'
import type { TaskConfigurationStore } from '../ports/task-configuration-store.js'
import { gitCommandError, isGitCommandSuccessful } from '../task/git-result.js'
import { loadTaskConfiguration } from '../task/load-task-configuration.js'
import { preflightRemotes, remoteFailureFor } from '../task/remote-preflight.js'
import {
  commandError,
  isConflictState,
  withActionResult,
  withCommandError,
} from '../task/repository-result.js'
import { selectRepositories } from '../task/select-repositories.js'
import { repositoryTaskPresentation } from '../task/repository-concurrency.js'
import { validateJobs } from '../task/validate-jobs.js'
import {
  runConcurrently,
  type ConcurrentTaskReporter,
} from '../../infrastructure/concurrency/concurrent-runner.js'
import type {
  CommandOutput,
  RepositoryCommandResult,
  TaskRepository,
} from '../../domain/task/model.js'
import { initialRepositoryResult } from '../../domain/task/model.js'

export interface FetchTaskInput {
  readonly interactive: boolean
  readonly jobs?: number
  readonly onProgress?: RepositoryProgressReporter
  readonly renderProgress?: boolean
  readonly repositories: readonly string[]
  readonly root: string
  readonly signal?: AbortSignal
}

export interface FetchTaskDependencies {
  readonly configurationStore: TaskConfigurationStore
  readonly git: GitRepositoryGateway
}

export async function fetchTask(
  dependencies: FetchTaskDependencies,
  input: FetchTaskInput,
): Promise<CommandOutput> {
  validateJobs(input.jobs)
  const configuration = await loadTaskConfiguration(
    dependencies.configurationStore,
    dependencies.git,
    { root: input.root, ...(input.signal ? { signal: input.signal } : {}) },
  )
  const repositories = selectRepositories(configuration, input.repositories)
  const inspected = await Promise.all(
    repositories.map((repository) =>
      dependencies.git.inspect(repository, withSignal(input.signal)),
    ),
  )
  const candidates = repositories.filter((_, index) =>
    canFetch(inspected[index] as RepositoryCommandResult),
  )
  const preflightFailures = await preflightRemotes(dependencies.git, candidates, {
    interactive: input.interactive,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const fetched = await fetchRepositories(dependencies.git, candidates, input, preflightFailures)
  const byName = new Map(fetched.map((result) => [result.name, result]))
  const results = repositories.map((repository, index) => {
    const result = byName.get(repository.name)
    return result ?? unavailableForFetch(inspected[index] as RepositoryCommandResult)
  })

  return {
    command: 'fetch',
    ok: results.every((result) => result.result !== 'failed' && !isConflictState(result.state)),
    repos: results,
  }
}

async function fetchRepositories(
  git: GitRepositoryGateway,
  repositories: readonly TaskRepository[],
  input: FetchTaskInput,
  preflightFailures: ReadonlyMap<string, ReturnType<typeof commandError>>,
): Promise<readonly RepositoryCommandResult[]> {
  const summary = await runConcurrently<TaskRepository, RepositoryCommandResult>(
    repositories,
    async (repository, _index, signal, task) => {
      updateProgress(input, task, repository, 'starting fetch')
      const preflightFailure = remoteFailureFor(preflightFailures, repository)
      if (preflightFailure) {
        const status = await git.inspect(repository, withSignal(signal))
        updateProgress(input, task, repository, 'fetch failed')
        return withCommandError(status, preflightFailure)
      }

      updateProgress(input, task, repository, 'fetching')
      const fetched = await git.fetch(repository.absolutePath, workerOptions(input, signal, task))
      const status = await git.inspect(repository, withSignal(signal))
      updateProgress(
        input,
        task,
        repository,
        isGitCommandSuccessful(fetched) ? 'fetched' : 'fetch failed',
      )
      return isGitCommandSuccessful(fetched)
        ? withActionResult(status, 'success')
        : withCommandError(status, gitCommandError(fetched))
    },
    {
      ...(input.jobs === undefined ? {} : { concurrency: input.jobs }),
      presentation: repositoryTaskPresentation(
        input.renderProgress === true,
        (repository) => repository,
      ),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  )

  return summary.results.map((entry) => {
    if (entry.status === 'fulfilled') return entry.value
    if (entry.status === 'not-run') {
      return withCommandError(
        initialRepositoryResult(entry.item),
        commandError('interrupted', 'Repository was not started before interruption.'),
        'not-run',
      )
    }
    const message = entry.error instanceof Error ? entry.error.message : String(entry.error)
    return withCommandError(
      initialRepositoryResult(entry.item),
      commandError('fetch-failed', message),
    )
  })
}

function canFetch(result: RepositoryCommandResult): boolean {
  return (
    result.result !== 'failed' &&
    result.state !== 'missing' &&
    result.state !== 'not-git' &&
    result.state !== 'wrong-repo'
  )
}

function unavailableForFetch(result: RepositoryCommandResult): RepositoryCommandResult {
  if (result.result === 'failed') return result
  return withCommandError(
    result,
    commandError(
      'repository-unavailable',
      `Cannot fetch repository in state ${result.state ?? 'unknown'}.`,
    ),
  )
}

function workerOptions(
  input: FetchTaskInput,
  signal: AbortSignal | undefined,
  task: ConcurrentTaskReporter,
): GitOperationOptions {
  return {
    interactive: input.interactive && input.jobs === 1,
    ...(task.enabled
      ? { onOutput: (chunk: { readonly text: string }): void => task.write(chunk.text) }
      : {}),
    ...(signal ? { signal } : {}),
  }
}

function updateProgress(
  input: Pick<FetchTaskInput, 'onProgress'>,
  task: ConcurrentTaskReporter,
  repository: TaskRepository,
  phase: string,
): void {
  task.update(phase)
  reportProgress(input.onProgress, { phase, repository: repository.name })
}

function withSignal(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal ? { signal } : {}
}
