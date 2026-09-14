import { Inject } from '@wendellhu/redi'

import {
  ConcurrentRunStatus,
  IConcurrencyService,
  IGitService,
  type IPushTaskService,
  ITaskConfigurationService,
  RepositoryActionResult,
  RepositoryState,
  reportProgress,
  type ConcurrentTaskReporter,
  type GitPushOptions,
  type PushTaskInput,
} from '../../../contract/index'
import { gitCommandError, isGitCommandSuccessful } from './gitResult'
import { loadTaskConfiguration } from './loadTaskConfiguration'
import { commandError, withActionResult, withCommandError } from './taskResult'
import { repositoryTaskPresentation } from './taskPresentation'
import { selectRepositories } from './taskSelection'
import { UsageError } from '../../../contract/index'
import type {
  CommandOutput,
  RepositoryCommandResult,
  TaskRepository,
} from '../../../contract/index'
import { initialRepositoryResult } from '../../../contract/index'

export class PushTaskService implements IPushTaskService {
  constructor(
    @Inject(IConcurrencyService) private readonly concurrency: IConcurrencyService,
    @Inject(ITaskConfigurationService)
    private readonly configurationStore: ITaskConfigurationService,
    @Inject(IGitService) private readonly git: IGitService,
  ) {}

  async execute(input: PushTaskInput): Promise<CommandOutput> {
    this.validateInput(input)
    const configuration = await loadTaskConfiguration(this.configurationStore, this.git, {
      root: input.root,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    const repositories = input.all
      ? configuration.repositories
      : selectRepositories(configuration, input.repositories)
    const inspected = await Promise.all(
      repositories.map((repository) => this.git.inspect(repository, withSignal(input.signal))),
    )
    const invalid = inspected.map((result, index) =>
      this.pushPrecondition(result, repositories[index] as TaskRepository),
    )

    if (invalid.some((error) => error !== undefined)) {
      return {
        command: 'push',
        ok: false,
        repos: inspected.map((result, index) => {
          const error = invalid[index]
          return error
            ? withCommandError(result, error)
            : withCommandError(
                result,
                commandError(
                  'preflight-blocked',
                  'Another repository failed local push preflight.',
                ),
                RepositoryActionResult.NotRun,
              )
        }),
      }
    }

    const results = await this.pushRepositories(repositories, input)

    return {
      command: 'push',
      ok: results.every((result) => result.result !== RepositoryActionResult.Failed),
      repos: results,
    }
  }

  private async pushRepositories(
    repositories: readonly TaskRepository[],
    input: PushTaskInput,
  ): Promise<readonly RepositoryCommandResult[]> {
    const summary = await this.concurrency.run<TaskRepository, RepositoryCommandResult>(
      repositories,
      async (repository, _index, signal, task) => {
        this.updateProgress(input, task, repository, input.dryRun ? 'dry-run pushing' : 'pushing')
        const result = await this.pushRepository(
          repository,
          { ...input, ...(signal ? { signal } : {}) },
          task,
        )
        this.updateProgress(
          input,
          task,
          repository,
          result.result === RepositoryActionResult.Failed
            ? 'push failed'
            : input.dryRun
              ? 'dry-run complete'
              : 'pushed',
        )
        return result
      },
      {
        concurrency: 1,
        presentation: repositoryTaskPresentation(
          input.renderProgress === true,
          (repository) => repository,
        ),
        ...(input.signal ? { signal: input.signal } : {}),
      },
    )

    return summary.results.map((entry) => {
      if (entry.status === ConcurrentRunStatus.Fulfilled) return entry.value
      if (entry.status === ConcurrentRunStatus.NotRun) {
        return withCommandError(
          initialRepositoryResult(entry.item),
          commandError('interrupted', 'Repository was not pushed before interruption.'),
          RepositoryActionResult.NotRun,
        )
      }
      const message = entry.error instanceof Error ? entry.error.message : String(entry.error)
      return withCommandError(
        initialRepositoryResult(entry.item),
        commandError('push-failed', message),
      )
    })
  }

  private validateInput(input: PushTaskInput): void {
    if (input.all && input.repositories.length > 0) {
      throw new UsageError('Use either --all or explicit repository names, not both.')
    }
    if (!input.all && input.repositories.length === 0) {
      throw new UsageError('Push requires --all or one or more repository names.')
    }
  }

  private pushPrecondition(
    result: RepositoryCommandResult,
    repository: TaskRepository,
  ): ReturnType<typeof commandError> | undefined {
    if (result.result === RepositoryActionResult.Failed) {
      return result.error ?? commandError('repository-unavailable', 'Could not inspect repository.')
    }
    if (
      result.state === RepositoryState.Missing ||
      result.state === RepositoryState.NotGit ||
      result.state === RepositoryState.WrongRepo
    ) {
      return commandError(
        'repository-unavailable',
        `Cannot push repository in state ${result.state}.`,
      )
    }
    if (result.state === RepositoryState.Detached) {
      return commandError('detached-head', 'Cannot push while HEAD is detached.')
    }
    if (result.actual.branch !== repository.branch) {
      return commandError('wrong-branch', `Expected branch '${repository.branch}' before pushing.`)
    }
    return undefined
  }

  private async pushRepository(
    repository: TaskRepository,
    input: PushTaskInput,
    task: ConcurrentTaskReporter,
  ): Promise<RepositoryCommandResult> {
    const before = await this.git.inspect(repository, withSignal(input.signal))
    if (before.state === RepositoryState.SyncedLocal)
      return withActionResult(before, RepositoryActionResult.Skipped)

    const options: GitPushOptions = {
      dryRun: input.dryRun,
      interactive: input.interactive,
      ...(task.enabled
        ? { onOutput: (chunk: { readonly text: string }): void => task.write(chunk.text) }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    }
    const pushed = await this.git.push(repository.absolutePath, repository.branch, options)
    const status = await this.git.inspect(repository, withSignal(input.signal))
    return isGitCommandSuccessful(pushed)
      ? withActionResult(status, RepositoryActionResult.Success)
      : withCommandError(status, gitCommandError(pushed))
  }

  private updateProgress(
    input: Pick<PushTaskInput, 'onProgress'>,
    task: ConcurrentTaskReporter,
    repository: TaskRepository,
    phase: string,
  ): void {
    task.update(phase)
    reportProgress(input.onProgress, { phase, repository: repository.name })
  }
}

function withSignal(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal ? { signal } : {}
}
