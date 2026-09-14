import { Inject } from '@wendellhu/redi'

import {
  ConcurrentRunStatus,
  GitBranchPreparationKind,
  IConcurrencyService,
  IGitService,
  type ISwitchTaskService,
  ITaskConfigurationService,
  RepositoryActionResult,
  RepositoryFlag,
  RepositoryState,
  reportProgress,
  type ConcurrentTaskReporter,
  type GitOperationOptions,
  type SwitchTaskInput,
} from '../../../contract/index'
import { checkoutDiffers, validateConfiguredCheckout } from './configuredCheckout'
import { gitCommandError, isGitCommandSuccessful } from './gitResult'
import { loadTaskConfiguration } from './loadTaskConfiguration'
import { preflightRemotes, remoteFailureFor } from './remotePreflight'
import { commandError, isConflictState, withActionResult, withCommandError } from './taskResult'
import { selectRepositories } from './taskSelection'
import { repositoryTaskPresentation } from './taskPresentation'
import { validateJobs } from './validateJobs'
import {
  initialRepositoryResult,
  type CommandOutput,
  type RepositoryCommandResult,
  type TaskRepository,
} from '../../../contract/index'

interface SwitchPlan {
  readonly initial: RepositoryCommandResult
  readonly needsFetch: boolean
  readonly repository: TaskRepository
}

export class SwitchTaskService implements ISwitchTaskService {
  constructor(
    @Inject(IConcurrencyService) private readonly concurrency: IConcurrencyService,
    @Inject(ITaskConfigurationService)
    private readonly configurationStore: ITaskConfigurationService,
    @Inject(IGitService) private readonly git: IGitService,
  ) {}

  async execute(input: SwitchTaskInput): Promise<CommandOutput> {
    validateJobs(input.jobs)
    const configuration = await loadTaskConfiguration(this.configurationStore, this.git, {
      root: input.root,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    const repositories = selectRepositories(configuration, input.repositories)
    const plans = await this.planSwitches(repositories, input.signal)
    const fetchCandidates = plans
      .filter(
        (plan) =>
          plan.needsFetch && (input.stash || !plan.initial.flags.includes(RepositoryFlag.Dirty)),
      )
      .map((plan) => plan.repository)
    const preflightFailures = await preflightRemotes(this.git, fetchCandidates, {
      interactive: input.interactive,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    const fetched = await this.fetchMissingBranches(fetchCandidates, input, preflightFailures)
    const fetchFailures = new Map(fetched.map((result) => [result.name, result]))
    const results = await this.switchRepositories(plans, fetchFailures, input)

    return {
      command: 'switch',
      ok: results.every(
        (result) =>
          result.result !== RepositoryActionResult.Failed && !isConflictState(result.state),
      ),
      repos: results,
    }
  }

  private async switchRepositories(
    plans: readonly SwitchPlan[],
    fetchFailures: ReadonlyMap<string, RepositoryCommandResult>,
    input: SwitchTaskInput,
  ): Promise<readonly RepositoryCommandResult[]> {
    const summary = await this.concurrency.run<SwitchPlan, RepositoryCommandResult>(
      plans,
      async (plan, _index, signal, task) => {
        updateProgress(input, task, plan.repository, 'switching')
        const result = await this.switchPlannedRepository(
          plan,
          fetchFailures.get(plan.repository.name),
          { ...input, ...(signal ? { signal } : {}) },
          task,
        )
        updateProgress(
          input,
          task,
          plan.repository,
          result.result === RepositoryActionResult.Failed ? 'switch failed' : 'switched',
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
      if (entry.status === ConcurrentRunStatus.Fulfilled) return entry.value
      if (entry.status === ConcurrentRunStatus.NotRun) {
        return withCommandError(
          initialRepositoryResult(entry.item.repository),
          commandError('interrupted', 'Repository was not switched before interruption.'),
          RepositoryActionResult.NotRun,
        )
      }
      const message = entry.error instanceof Error ? entry.error.message : String(entry.error)
      return withCommandError(
        initialRepositoryResult(entry.item.repository),
        commandError('switch-failed', message),
      )
    })
  }

  private async planSwitches(
    repositories: readonly TaskRepository[],
    signal: AbortSignal | undefined,
  ): Promise<readonly SwitchPlan[]> {
    return Promise.all(
      repositories.map(async (repository) => {
        const initial = await this.git.inspect(repository, withSignal(signal))
        if (
          !canSwitch(initial) ||
          (initial.actual.branch === repository.branch && !checkoutDiffers(initial))
        ) {
          return { initial, needsFetch: false, repository }
        }

        const localBranch = await this.git.hasRef(
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

  private async fetchMissingBranches(
    repositories: readonly TaskRepository[],
    input: SwitchTaskInput,
    preflightFailures: ReadonlyMap<string, ReturnType<typeof commandError>>,
  ): Promise<readonly RepositoryCommandResult[]> {
    const summary = await this.concurrency.run<TaskRepository, RepositoryCommandResult>(
      repositories,
      async (repository, _index, signal, task) => {
        updateProgress(input, task, repository, 'starting branch fetch')
        const preflightFailure = remoteFailureFor(preflightFailures, repository)
        if (preflightFailure) {
          updateProgress(input, task, repository, 'fetch failed')
          return withCommandError(initialRepositoryResult(repository), preflightFailure)
        }
        updateProgress(input, task, repository, 'fetching')
        const fetched = await this.git.fetch(
          repository.absolutePath,
          workerOptions(input, signal, task),
        )
        updateProgress(
          input,
          task,
          repository,
          isGitCommandSuccessful(fetched) ? 'fetched' : 'fetch failed',
        )
        return isGitCommandSuccessful(fetched)
          ? withActionResult(initialRepositoryResult(repository), RepositoryActionResult.Success)
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
      if (entry.status === ConcurrentRunStatus.Fulfilled) return entry.value
      if (entry.status === ConcurrentRunStatus.NotRun) {
        return withCommandError(
          initialRepositoryResult(entry.item),
          commandError('interrupted', 'Fetch was not started before interruption.'),
          RepositoryActionResult.NotRun,
        )
      }
      const message = entry.error instanceof Error ? entry.error.message : String(entry.error)
      return withCommandError(
        initialRepositoryResult(entry.item),
        commandError('fetch-failed', message),
      )
    })
  }

  private async switchPlannedRepository(
    plan: SwitchPlan,
    fetchResult: RepositoryCommandResult | undefined,
    input: SwitchTaskInput,
    task: ConcurrentTaskReporter,
  ): Promise<RepositoryCommandResult> {
    const { initial, repository } = plan
    if (!canSwitch(initial)) return unavailableForSwitch(initial)
    const branchChanges = initial.actual.branch !== repository.branch
    const checkoutChanges = checkoutDiffers(initial)
    if (!branchChanges && !checkoutChanges)
      return withActionResult(initial, RepositoryActionResult.Skipped)
    if (fetchResult?.result === RepositoryActionResult.Failed) return fetchResult

    const dirty = initial.flags.includes(RepositoryFlag.Dirty)
    if (dirty && !input.stash) {
      return withCommandError(
        initial,
        commandError('dirty-worktree', 'Use --stash to save uncommitted changes before switching.'),
      )
    }
    if (dirty) {
      const stashed = await this.git.stash(
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
      const prepared = await this.git.prepareBranch(
        repository.absolutePath,
        { branch: repository.branch, from: repository.from, fetchIfMissing: false },
        workerOptions(input, input.signal, task),
      )
      if (prepared.kind === GitBranchPreparationKind.Failed) {
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
        this.git,
        repository.absolutePath,
        repository,
        options,
      )
      if (validationError !== null) return withCommandError(initial, validationError)

      const applied = await this.git.applyCheckout(
        repository.absolutePath,
        repository.checkout,
        options,
      )
      if (!isGitCommandSuccessful(applied)) {
        return withCommandError(initial, gitCommandError(applied))
      }
    }

    const status = await this.git.inspect(repository, withSignal(input.signal))
    if (checkoutDiffers(status)) {
      return withCommandError(
        status,
        commandError(
          'checkout-reconciliation-failed',
          'Git did not apply the configured checkout directories.',
        ),
      )
    }
    return withActionResult(
      status,
      status.result === RepositoryActionResult.Failed
        ? RepositoryActionResult.Failed
        : RepositoryActionResult.Success,
    )
  }
}

function canSwitch(result: RepositoryCommandResult): boolean {
  return (
    result.result !== RepositoryActionResult.Failed &&
    result.state !== RepositoryState.Missing &&
    result.state !== RepositoryState.NotGit &&
    result.state !== RepositoryState.WrongRepo
  )
}

function unavailableForSwitch(result: RepositoryCommandResult): RepositoryCommandResult {
  if (result.result === RepositoryActionResult.Failed) return result
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
