import type { GitOperationOptions, GitRepositoryGateway } from '../ports/git-repository-gateway.js'
import { reportProgress, type RepositoryProgressReporter } from '../ports/progress-reporter.js'
import type { TaskConfigurationStore } from '../ports/task-configuration-store.js'
import { checkoutDiffers, validateConfiguredCheckout } from '../task/configured-checkout.js'
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
import {
  initialRepositoryResult,
  type CommandOutput,
  type RepositoryCommandResult,
  type TaskRepository,
} from '../../domain/task/model.js'

export interface SwitchTaskInput {
  readonly interactive: boolean
  readonly jobs?: number
  readonly onStash?: (repository: string, reference: string) => void
  readonly onProgress?: RepositoryProgressReporter
  readonly renderProgress?: boolean
  readonly repositories: readonly string[]
  readonly root: string
  readonly signal?: AbortSignal
  readonly stash: boolean
}

export interface SwitchTaskDependencies {
  readonly configurationStore: TaskConfigurationStore
  readonly git: GitRepositoryGateway
}

interface SwitchPlan {
  readonly initial: RepositoryCommandResult
  readonly needsFetch: boolean
  readonly repository: TaskRepository
}

export async function switchTask(
  dependencies: SwitchTaskDependencies,
  input: SwitchTaskInput,
): Promise<CommandOutput> {
  validateJobs(input.jobs)
  const configuration = await loadTaskConfiguration(
    dependencies.configurationStore,
    dependencies.git,
    { root: input.root, ...(input.signal ? { signal: input.signal } : {}) },
  )
  const repositories = selectRepositories(configuration, input.repositories)
  const plans = await planSwitches(dependencies.git, repositories, input.signal)
  const fetchCandidates = plans
    .filter((plan) => plan.needsFetch && (input.stash || !plan.initial.flags.includes('dirty')))
    .map((plan) => plan.repository)
  const preflightFailures = await preflightRemotes(dependencies.git, fetchCandidates, {
    interactive: input.interactive,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const fetched = await fetchMissingBranches(
    dependencies.git,
    fetchCandidates,
    input,
    preflightFailures,
  )
  const fetchFailures = new Map(fetched.map((result) => [result.name, result]))
  const results = await switchRepositories(dependencies.git, plans, fetchFailures, input)

  return {
    command: 'switch',
    ok: results.every((result) => result.result !== 'failed' && !isConflictState(result.state)),
    repos: results,
  }
}

async function switchRepositories(
  git: GitRepositoryGateway,
  plans: readonly SwitchPlan[],
  fetchFailures: ReadonlyMap<string, RepositoryCommandResult>,
  input: SwitchTaskInput,
): Promise<readonly RepositoryCommandResult[]> {
  const summary = await runConcurrently<SwitchPlan, RepositoryCommandResult>(
    plans,
    async (plan, _index, signal, task) => {
      updateProgress(input, task, plan.repository, 'switching')
      const result = await switchPlannedRepository(
        git,
        plan,
        fetchFailures.get(plan.repository.name),
        { ...input, ...(signal ? { signal } : {}) },
        task,
      )
      updateProgress(
        input,
        task,
        plan.repository,
        result.result === 'failed' ? 'switch failed' : 'switched',
      )
      return result
    },
    {
      concurrency: 1,
      presentation: repositoryTaskPresentation(
        input.renderProgress === true,
        (plan) => plan.repository,
        'Switch',
      ),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  )

  return summary.results.map((entry) => {
    if (entry.status === 'fulfilled') return entry.value
    if (entry.status === 'not-run') {
      return withCommandError(
        initialRepositoryResult(entry.item.repository),
        commandError('interrupted', 'Repository was not switched before interruption.'),
        'not-run',
      )
    }
    const message = entry.error instanceof Error ? entry.error.message : String(entry.error)
    return withCommandError(
      initialRepositoryResult(entry.item.repository),
      commandError('switch-failed', message),
    )
  })
}

async function planSwitches(
  git: GitRepositoryGateway,
  repositories: readonly TaskRepository[],
  signal: AbortSignal | undefined,
): Promise<readonly SwitchPlan[]> {
  return Promise.all(
    repositories.map(async (repository) => {
      const initial = await git.inspect(repository, withSignal(signal))
      if (
        !canSwitch(initial) ||
        (initial.actual.branch === repository.branch && !checkoutDiffers(initial))
      ) {
        return { initial, needsFetch: false, repository }
      }

      const localBranch = await git.hasRef(
        repository.absolutePath,
        `refs/heads/${repository.branch}`,
        withSignal(signal),
      )
      const needsFetch = !localBranch.exists && localBranch.command.exitCode === 1
      const plannedInitial =
        localBranch.command.exitCode === 0 || localBranch.command.exitCode === 1
          ? initial
          : withCommandError(initial, gitCommandError(localBranch.command))
      return { initial: plannedInitial, needsFetch, repository }
    }),
  )
}

async function fetchMissingBranches(
  git: GitRepositoryGateway,
  repositories: readonly TaskRepository[],
  input: SwitchTaskInput,
  preflightFailures: ReadonlyMap<string, ReturnType<typeof commandError>>,
): Promise<readonly RepositoryCommandResult[]> {
  const summary = await runConcurrently<TaskRepository, RepositoryCommandResult>(
    repositories,
    async (repository, _index, signal, task) => {
      updateProgress(input, task, repository, 'starting branch fetch')
      const preflightFailure = remoteFailureFor(preflightFailures, repository)
      if (preflightFailure) {
        updateProgress(input, task, repository, 'fetch failed')
        return withCommandError(initialRepositoryResult(repository), preflightFailure)
      }
      updateProgress(input, task, repository, 'fetching')
      const fetched = await git.fetch(repository.absolutePath, workerOptions(input, signal, task))
      updateProgress(
        input,
        task,
        repository,
        isGitCommandSuccessful(fetched) ? 'fetched' : 'fetch failed',
      )
      return isGitCommandSuccessful(fetched)
        ? withActionResult(initialRepositoryResult(repository), 'success')
        : withCommandError(initialRepositoryResult(repository), gitCommandError(fetched))
    },
    {
      ...(input.jobs === undefined ? {} : { concurrency: input.jobs }),
      presentation: repositoryTaskPresentation(
        input.renderProgress === true,
        (repository) => repository,
        'Fetch',
      ),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  )

  return summary.results.map((entry) => {
    if (entry.status === 'fulfilled') return entry.value
    if (entry.status === 'not-run') {
      return withCommandError(
        initialRepositoryResult(entry.item),
        commandError('interrupted', 'Fetch was not started before interruption.'),
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

async function switchPlannedRepository(
  git: GitRepositoryGateway,
  plan: SwitchPlan,
  fetchResult: RepositoryCommandResult | undefined,
  input: SwitchTaskInput,
  task: ConcurrentTaskReporter,
): Promise<RepositoryCommandResult> {
  const { initial, repository } = plan
  if (!canSwitch(initial)) return unavailableForSwitch(initial)
  const branchChanges = initial.actual.branch !== repository.branch
  const checkoutChanges = checkoutDiffers(initial)
  if (!branchChanges && !checkoutChanges) return withActionResult(initial, 'skipped')
  if (fetchResult?.result === 'failed') return fetchResult

  const dirty = initial.flags.includes('dirty')
  if (dirty && !input.stash) {
    return withCommandError(
      initial,
      commandError('dirty-worktree', 'Use --stash to save uncommitted changes before switching.'),
    )
  }
  if (dirty) {
    const stashed = await git.stash(
      repository.absolutePath,
      `gits switch: ${basenameTask(input.root)}/${repository.name}`,
      workerOptions(input, input.signal, task),
    )
    if (!isGitCommandSuccessful(stashed.command)) {
      return withCommandError(initial, gitCommandError(stashed.command))
    }
    if (stashed.reference) {
      updateProgress(input, task, repository, `stashed as ${stashed.reference}`)
      input.onStash?.(repository.name, stashed.reference)
    }
  }

  if (branchChanges) {
    const prepared = await git.prepareBranch(
      repository.absolutePath,
      { branch: repository.branch, from: repository.from, fetchIfMissing: false },
      workerOptions(input, input.signal, task),
    )
    if (prepared.kind === 'failed') {
      const command = prepared.commands.at(-1)
      return withCommandError(
        initial,
        command
          ? gitCommandError(command)
          : commandError('branch-preparation-failed', 'Could not switch to task branch.'),
      )
    }
  }

  if (checkoutChanges || (branchChanges && repository.checkout !== null)) {
    updateProgress(input, task, repository, 'applying checkout')
    const options = workerOptions(input, input.signal, task)
    const validationError = await validateConfiguredCheckout(
      git,
      repository.absolutePath,
      repository,
      options,
    )
    if (validationError !== null) return withCommandError(initial, validationError)

    const applied = await git.applyCheckout(repository.absolutePath, repository.checkout, options)
    if (!isGitCommandSuccessful(applied)) {
      return withCommandError(initial, gitCommandError(applied))
    }
  }

  const status = await git.inspect(repository, withSignal(input.signal))
  if (checkoutDiffers(status)) {
    return withCommandError(
      status,
      commandError(
        'checkout-reconciliation-failed',
        'Git did not apply the configured checkout directories.',
      ),
    )
  }
  return withActionResult(status, status.result === 'failed' ? 'failed' : 'success')
}

function canSwitch(result: RepositoryCommandResult): boolean {
  return (
    result.result !== 'failed' &&
    result.state !== 'missing' &&
    result.state !== 'not-git' &&
    result.state !== 'wrong-repo'
  )
}

function unavailableForSwitch(result: RepositoryCommandResult): RepositoryCommandResult {
  if (result.result === 'failed') return result
  return withCommandError(
    result,
    commandError(
      'repository-unavailable',
      `Cannot switch repository in state ${result.state ?? 'unknown'}.`,
    ),
  )
}

function workerOptions(
  input: SwitchTaskInput,
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
  input: Pick<SwitchTaskInput, 'onProgress'>,
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

function basenameTask(root: string): string {
  const segments = root.split(/[\\/]/u).filter(Boolean)
  return segments.at(-1) ?? 'task'
}
