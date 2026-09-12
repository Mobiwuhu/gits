import type { GitPushOptions, GitRepositoryGateway } from '../ports/git-repository-gateway.js'
import { reportProgress, type RepositoryProgressReporter } from '../ports/progress-reporter.js'
import type { TaskConfigurationStore } from '../ports/task-configuration-store.js'
import { gitCommandError, isGitCommandSuccessful } from '../task/git-result.js'
import { loadTaskConfiguration } from '../task/load-task-configuration.js'
import { commandError, withActionResult, withCommandError } from '../task/repository-result.js'
import { repositoryTaskPresentation } from '../task/repository-concurrency.js'
import { selectRepositories } from '../task/select-repositories.js'
import { UsageError } from '../../domain/task/errors.js'
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

export interface PushTaskInput {
  readonly all: boolean
  readonly dryRun: boolean
  readonly interactive: boolean
  readonly onProgress?: RepositoryProgressReporter
  readonly renderProgress?: boolean
  readonly repositories: readonly string[]
  readonly root: string
  readonly signal?: AbortSignal
}

export interface PushTaskDependencies {
  readonly configurationStore: TaskConfigurationStore
  readonly git: GitRepositoryGateway
}

export async function pushTask(
  dependencies: PushTaskDependencies,
  input: PushTaskInput,
): Promise<CommandOutput> {
  validatePushInput(input)
  const configuration = await loadTaskConfiguration(
    dependencies.configurationStore,
    dependencies.git,
    { root: input.root, ...(input.signal ? { signal: input.signal } : {}) },
  )
  const repositories = input.all
    ? configuration.repositories
    : selectRepositories(configuration, input.repositories)
  const inspected = await Promise.all(
    repositories.map((repository) =>
      dependencies.git.inspect(repository, withSignal(input.signal)),
    ),
  )
  const invalid = inspected.map((result, index) =>
    pushPrecondition(result, repositories[index] as TaskRepository),
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
              commandError('preflight-blocked', 'Another repository failed local push preflight.'),
              'not-run',
            )
      }),
    }
  }

  const results = await pushRepositories(dependencies.git, repositories, input)

  return {
    command: 'push',
    ok: results.every((result) => result.result !== 'failed'),
    repos: results,
  }
}

async function pushRepositories(
  git: GitRepositoryGateway,
  repositories: readonly TaskRepository[],
  input: PushTaskInput,
): Promise<readonly RepositoryCommandResult[]> {
  const summary = await runConcurrently<TaskRepository, RepositoryCommandResult>(
    repositories,
    async (repository, _index, signal, task) => {
      updateProgress(input, task, repository, input.dryRun ? 'dry-run pushing' : 'pushing')
      const result = await pushRepository(
        git,
        repository,
        { ...input, ...(signal ? { signal } : {}) },
        task,
      )
      updateProgress(
        input,
        task,
        repository,
        result.result === 'failed' ? 'push failed' : input.dryRun ? 'dry-run complete' : 'pushed',
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
    if (entry.status === 'fulfilled') return entry.value
    if (entry.status === 'not-run') {
      return withCommandError(
        initialRepositoryResult(entry.item),
        commandError('interrupted', 'Repository was not pushed before interruption.'),
        'not-run',
      )
    }
    const message = entry.error instanceof Error ? entry.error.message : String(entry.error)
    return withCommandError(
      initialRepositoryResult(entry.item),
      commandError('push-failed', message),
    )
  })
}

function validatePushInput(input: PushTaskInput): void {
  if (input.all && input.repositories.length > 0) {
    throw new UsageError('Use either --all or explicit repository names, not both.')
  }
  if (!input.all && input.repositories.length === 0) {
    throw new UsageError('Push requires --all or one or more repository names.')
  }
}

function pushPrecondition(
  result: RepositoryCommandResult,
  repository: TaskRepository,
): ReturnType<typeof commandError> | undefined {
  if (result.result === 'failed') {
    return result.error ?? commandError('repository-unavailable', 'Could not inspect repository.')
  }
  if (result.state === 'missing' || result.state === 'not-git' || result.state === 'wrong-repo') {
    return commandError(
      'repository-unavailable',
      `Cannot push repository in state ${result.state}.`,
    )
  }
  if (result.state === 'detached') {
    return commandError('detached-head', 'Cannot push while HEAD is detached.')
  }
  if (result.actual.branch !== repository.branch) {
    return commandError('wrong-branch', `Expected branch '${repository.branch}' before pushing.`)
  }
  return undefined
}

async function pushRepository(
  git: GitRepositoryGateway,
  repository: TaskRepository,
  input: PushTaskInput,
  task: ConcurrentTaskReporter,
): Promise<RepositoryCommandResult> {
  const before = await git.inspect(repository, withSignal(input.signal))
  if (before.state === 'synced-local') return withActionResult(before, 'skipped')

  const options: GitPushOptions = {
    dryRun: input.dryRun,
    interactive: input.interactive,
    ...(task.enabled
      ? { onOutput: (chunk: { readonly text: string }): void => task.write(chunk.text) }
      : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  }
  const pushed = await git.push(repository.absolutePath, repository.branch, options)
  const status = await git.inspect(repository, withSignal(input.signal))
  return isGitCommandSuccessful(pushed)
    ? withActionResult(status, 'success')
    : withCommandError(status, gitCommandError(pushed))
}

function updateProgress(
  input: Pick<PushTaskInput, 'onProgress'>,
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
