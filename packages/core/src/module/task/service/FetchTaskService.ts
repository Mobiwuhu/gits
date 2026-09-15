import { Inject } from '@wendellhu/redi'

import {
  ConcurrentRunStatus,
  IConcurrencyService,
  IGitService,
  ITaskConfigurationService,
  RepositoryActionResult,
  RepositoryState,
  reportProgress,
  initialRepositoryResult,
} from '../../../contract/index'
import type {
  IFetchTaskService,
  ConcurrentTaskReporter,
  FetchTaskInput,
  GitOperationOptions,
  CommandOutput,
  RepositoryCommandResult,
  TaskRepository,
} from '../../../contract/index'
import { gitCommandError, isGitCommandSuccessful } from './gitResult'
import { loadTaskConfiguration } from './loadTaskConfiguration'
import { preflightRemotes, remoteFailureFor } from './remotePreflight'
import { repositoryTaskPresentation } from './taskPresentation'
import {
  commandError,
  isConflictState,
  withActionResult,
  withCommandError,
} from './taskResult'
import { selectRepositories } from './taskSelection'
import { validateJobs } from './validateJobs'

export class FetchTaskService implements IFetchTaskService {
  constructor(
    @Inject(IConcurrencyService)
    private readonly concurrency: IConcurrencyService,
    @Inject(ITaskConfigurationService)
    private readonly configurationStore: ITaskConfigurationService,
    @Inject(IGitService) private readonly git: IGitService
  ) {}

  async execute(input: FetchTaskInput): Promise<CommandOutput> {
    validateJobs(input.jobs)
    const configuration = await loadTaskConfiguration(
      this.configurationStore,
      this.git,
      {
        root: input.root,
        ...(input.signal ? { signal: input.signal } : {}),
      }
    )
    const repositories = selectRepositories(configuration, input.repositories)
    const inspected = await Promise.all(
      repositories.map(async (repository) => ({
        repository,
        result: await this.git.inspect(repository, withSignal(input.signal)),
      }))
    )
    const candidates = inspected
      .filter(({ result }) => canFetch(result))
      .map(({ repository }) => repository)
    const preflightFailures = await preflightRemotes(this.git, candidates, {
      interactive: input.interactive,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    const fetched = await this.fetchRepositories(
      candidates,
      input,
      preflightFailures
    )
    const byName = new Map(fetched.map((result) => [result.name, result]))
    const results = inspected.map(({ repository, result: inspectedResult }) => {
      const fetchedResult = byName.get(repository.name)
      return fetchedResult ?? unavailableForFetch(inspectedResult)
    })

    return {
      command: 'fetch',
      ok: results.every(
        (result) =>
          result.result !== RepositoryActionResult.Failed &&
          !isConflictState(result.state)
      ),
      repos: results,
    }
  }

  private async fetchRepositories(
    repositories: readonly TaskRepository[],
    input: FetchTaskInput,
    preflightFailures: ReadonlyMap<string, ReturnType<typeof commandError>>
  ): Promise<readonly RepositoryCommandResult[]> {
    const summary = await this.concurrency.run<
      TaskRepository,
      RepositoryCommandResult
    >(
      repositories,
      async (repository, _index, signal, task) => {
        updateProgress(input, task, repository, 'starting fetch')
        const preflightFailure = remoteFailureFor(preflightFailures, repository)
        if (preflightFailure) {
          const status = await this.git.inspect(repository, withSignal(signal))
          updateProgress(input, task, repository, 'fetch failed')
          return withCommandError(status, preflightFailure)
        }

        updateProgress(input, task, repository, 'fetching')
        const fetched = await this.git.fetch(
          repository.absolutePath,
          workerOptions(input, signal, task)
        )
        const status = await this.git.inspect(repository, withSignal(signal))
        updateProgress(
          input,
          task,
          repository,
          isGitCommandSuccessful(fetched) ? 'fetched' : 'fetch failed'
        )
        return isGitCommandSuccessful(fetched)
          ? withActionResult(status, RepositoryActionResult.Success)
          : withCommandError(status, gitCommandError(fetched))
      },
      {
        ...(input.jobs === undefined ? {} : { concurrency: input.jobs }),
        presentation: repositoryTaskPresentation(
          input.renderProgress === true,
          (repository) => repository
        ),
        ...(input.signal ? { signal: input.signal } : {}),
      }
    )

    return summary.results.map((entry) => {
      if (entry.status === ConcurrentRunStatus.Fulfilled) {
        return entry.value
      }
      if (entry.status === ConcurrentRunStatus.NotRun) {
        return withCommandError(
          initialRepositoryResult(entry.item),
          commandError(
            'interrupted',
            'Repository was not started before interruption.'
          ),
          RepositoryActionResult.NotRun
        )
      }
      const message =
        entry.error instanceof Error ? entry.error.message : String(entry.error)
      return withCommandError(
        initialRepositoryResult(entry.item),
        commandError('fetch-failed', message)
      )
    })
  }
}

function canFetch(result: RepositoryCommandResult): boolean {
  return (
    result.result !== RepositoryActionResult.Failed &&
    result.state !== RepositoryState.Missing &&
    result.state !== RepositoryState.NotGit &&
    result.state !== RepositoryState.WrongRepo
  )
}

function unavailableForFetch(
  result: RepositoryCommandResult
): RepositoryCommandResult {
  if (result.result === RepositoryActionResult.Failed) {
    return result
  }
  return withCommandError(
    result,
    commandError(
      'repository-unavailable',
      `Cannot fetch repository in state ${result.state ?? 'unknown'}.`
    )
  )
}

function workerOptions(
  input: FetchTaskInput,
  signal: AbortSignal | undefined,
  task: ConcurrentTaskReporter
): GitOperationOptions {
  return {
    interactive: input.interactive && input.jobs === 1,
    ...(task.enabled
      ? {
          onOutput: (chunk: { readonly text: string }): void => {
            task.write(chunk.text)
          },
        }
      : {}),
    ...(signal ? { signal } : {}),
  }
}

function updateProgress(
  input: Pick<FetchTaskInput, 'onProgress'>,
  task: ConcurrentTaskReporter,
  repository: TaskRepository,
  phase: string
): void {
  task.update(phase)
  reportProgress(input.onProgress, { phase, repository: repository.name })
}

function withSignal(signal: AbortSignal | undefined): {
  readonly signal?: AbortSignal
} {
  return signal ? { signal } : {}
}
