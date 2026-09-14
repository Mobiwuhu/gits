import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { Inject } from '@wendellhu/redi'

import type { GitCloneOptions, GitOperationOptions } from '../../../contract/index'
import {
  ConcurrentRunStatus,
  GitBranchPreparationKind,
  IConcurrencyService,
  IGitService,
  type IInstallTaskService,
  IRepoMirrorDependencyService,
  IResolveRepoMirrorService,
  ITaskConfigurationService,
  RepositoryActionResult,
  RepositoryFlag,
  RepositoryState,
  reportProgress,
  type ConcurrentTaskReporter,
  type InstallTaskInput,
  type RepoMirrorLease,
} from '../../../contract/index'
import { checkoutDiffers, validateConfiguredCheckout } from './configuredCheckout'
import { loadTaskConfiguration } from './loadTaskConfiguration'
import { gitCommandError, isGitCommandSuccessful } from './gitResult'
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

interface ExistingCheckoutPlan {
  readonly initial: RepositoryCommandResult
  readonly repository: TaskRepository
}

export class InstallTaskService implements IInstallTaskService {
  constructor(
    @Inject(IConcurrencyService) private readonly concurrency: IConcurrencyService,
    @Inject(ITaskConfigurationService)
    private readonly configurationStore: ITaskConfigurationService,
    @Inject(IGitService) private readonly git: IGitService,
    @Inject(IRepoMirrorDependencyService)
    private readonly repoMirrorDependencies: IRepoMirrorDependencyService,
    @Inject(IResolveRepoMirrorService)
    private readonly repoMirrorResolver: IResolveRepoMirrorService,
  ) {}

  async execute(input: InstallTaskInput): Promise<CommandOutput> {
    validateJobs(input.jobs)
    const configuration = await loadTaskConfiguration(this.configurationStore, this.git, {
      root: input.root,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    const repositories = selectRepositories(configuration, input.repositories)
    const inspected = await Promise.all(
      repositories.map((repository) => this.git.inspect(repository, withSignal(input.signal))),
    )
    const missing = repositories.filter(
      (_, index) => inspected[index]?.state === RepositoryState.Missing,
    )
    const preflightFailures = await preflightRemotes(this.git, missing, {
      interactive: input.interactive,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    const installed = await this.installMissingRepositories(missing, input, preflightFailures)
    const checkoutPlans = repositories.flatMap((repository, index) => {
      const initial = inspected[index] as RepositoryCommandResult
      return checkoutDiffers(initial) && canReconcileCheckout(initial)
        ? [{ initial, repository }]
        : []
    })
    const reconciled = await this.reconcileExistingCheckouts(checkoutPlans, input)
    const byName = new Map(
      [...installed, ...reconciled].map((result) => [result.name, result] as const),
    )
    const results = repositories.map((repository, index) => {
      const state = inspected[index] as RepositoryCommandResult
      return byName.get(repository.name) ?? resultForExistingRepository(state)
    })

    return {
      command: 'install',
      ok: results.every((result) => result.result !== RepositoryActionResult.Failed),
      repos: results,
    }
  }

  private async reconcileExistingCheckouts(
    plans: readonly ExistingCheckoutPlan[],
    input: InstallTaskInput,
  ): Promise<readonly RepositoryCommandResult[]> {
    const summary = await this.concurrency.run<ExistingCheckoutPlan, RepositoryCommandResult>(
      plans,
      async (plan, _index, signal, task) => {
        const options = operationOptions({ ...input, ...(signal ? { signal } : {}) }, task)
        updateProgress(input, task, plan.repository, 'aligning checkout')
        if (plan.initial.flags.includes(RepositoryFlag.Dirty)) {
          return withCommandError(
            plan.initial,
            commandError(
              'dirty-worktree',
              'Commit, stash, or remove worktree changes before changing checkout directories.',
            ),
          )
        }

        const validationError = await validateConfiguredCheckout(
          this.git,
          plan.repository.absolutePath,
          plan.repository,
          options,
        )
        if (validationError !== null) return withCommandError(plan.initial, validationError)

        const applied = await this.git.applyCheckout(
          plan.repository.absolutePath,
          plan.repository.checkout,
          options,
        )
        if (!isGitCommandSuccessful(applied)) {
          return withCommandError(plan.initial, gitCommandError(applied))
        }

        const status = await this.git.inspect(plan.repository, withSignal(signal))
        if (checkoutDiffers(status)) {
          return withCommandError(
            status,
            commandError(
              'checkout-reconciliation-failed',
              'Git did not apply the configured checkout directories.',
            ),
          )
        }
        updateProgress(input, task, plan.repository, 'checkout aligned')
        return withActionResult(
          status,
          status.result === RepositoryActionResult.Failed
            ? RepositoryActionResult.Failed
            : RepositoryActionResult.Success,
        )
      },
      {
        ...(input.jobs === undefined ? {} : { concurrency: input.jobs }),
        presentation: repositoryTaskPresentation(
          input.renderProgress === true,
          (plan) => plan.repository,
          'Checkout',
        ),
        ...(input.signal ? { signal: input.signal } : {}),
      },
    )

    return summary.results.map((entry) => {
      if (entry.status === ConcurrentRunStatus.Fulfilled) return entry.value
      if (entry.status === ConcurrentRunStatus.NotRun) {
        return withCommandError(
          initialRepositoryResult(entry.item.repository),
          commandError('interrupted', 'Checkout was not aligned before interruption.'),
          RepositoryActionResult.NotRun,
        )
      }
      const message = entry.error instanceof Error ? entry.error.message : String(entry.error)
      return withCommandError(
        initialRepositoryResult(entry.item.repository),
        commandError('checkout-reconciliation-failed', message),
      )
    })
  }

  private async installMissingRepositories(
    repositories: readonly TaskRepository[],
    input: InstallTaskInput,
    preflightFailures: ReadonlyMap<string, ReturnType<typeof commandError>>,
  ): Promise<readonly RepositoryCommandResult[]> {
    const summary = await this.concurrency.run<TaskRepository, RepositoryCommandResult>(
      repositories,
      async (repository, _index, signal, task) => {
        updateProgress(input, task, repository, 'starting install')
        const preflightFailure = remoteFailureFor(preflightFailures, repository)
        if (preflightFailure) {
          return withCommandError(initialRepositoryResult(repository), preflightFailure)
        }
        return this.installRepository(
          repository,
          {
            ...input,
            ...(signal ? { signal } : {}),
          },
          task,
        )
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
      if (entry.status === ConcurrentRunStatus.Fulfilled) return entry.value
      if (entry.status === ConcurrentRunStatus.NotRun) {
        return withCommandError(
          initialRepositoryResult(entry.item),
          commandError('interrupted', 'Repository was not started before interruption.'),
          RepositoryActionResult.NotRun,
        )
      }
      const message = entry.error instanceof Error ? entry.error.message : String(entry.error)
      return withCommandError(
        initialRepositoryResult(entry.item),
        commandError('install-failed', message),
      )
    })
  }

  private async installRepository(
    repository: TaskRepository,
    input: Omit<InstallTaskInput, 'repositories'>,
    task: ConcurrentTaskReporter,
  ): Promise<RepositoryCommandResult> {
    const reposRoot = resolve(input.root, 'repos')
    await mkdir(reposRoot, { recursive: true })
    const temporaryRoot = await mkdtemp(join(reposRoot, '.gits-install-'))
    const temporaryRepository = join(temporaryRoot, 'repository')
    let activeLease: RepoMirrorLease | null = null
    let selectedMirror: RepoMirrorLease | null = null
    let fallbackReason: string | undefined

    try {
      const resolution = await this.repoMirrorResolver.resolve(repository.url)
      activeLease = resolution.lease
      selectedMirror = resolution.lease
      fallbackReason = resolution.fallbackReason

      updateProgress(input, task, repository, 'cloning')
      let clone = await this.git.clone(
        repository.url,
        temporaryRepository,
        cloneOptions(input, activeLease, repository.dissociate, repository.checkout !== null, task),
      )
      if (!isGitCommandSuccessful(clone) && activeLease !== null) {
        fallbackReason = `Repo mirror '${activeLease.name}' could not be used: ${gitCommandError(clone).message}`
        updateProgress(input, task, repository, 'mirror unavailable; cloning from origin')
        await rm(temporaryRepository, { force: true, recursive: true })
        await activeLease.release()
        activeLease = null
        selectedMirror = null
        clone = await this.git.clone(
          repository.url,
          temporaryRepository,
          cloneOptions(input, null, false, repository.checkout !== null, task),
        )
      }
      if (!isGitCommandSuccessful(clone)) {
        return withInstallMetadata(
          withCommandError(initialRepositoryResult(repository), gitCommandError(clone)),
          null,
          fallbackReason,
          repository.dissociate,
        )
      }

      if (repository.checkout !== null) {
        updateProgress(input, task, repository, 'configuring checkout')
        const applied = await this.git.applyCheckout(
          temporaryRepository,
          repository.checkout,
          operationOptions(input, task),
        )
        if (!isGitCommandSuccessful(applied)) {
          return withInstallMetadata(
            withCommandError(initialRepositoryResult(repository), gitCommandError(applied)),
            null,
            fallbackReason,
            repository.dissociate,
          )
        }
      }

      updateProgress(input, task, repository, 'preparing branch')
      const prepared = await this.git.prepareBranch(
        temporaryRepository,
        { branch: repository.branch, from: repository.from },
        operationOptions(input, task),
      )
      if (prepared.kind === GitBranchPreparationKind.Failed) {
        const command = prepared.commands.at(-1)
        return withCommandError(
          initialRepositoryResult(repository),
          command
            ? gitCommandError(command)
            : commandError('branch-preparation-failed', 'Could not prepare task branch.'),
        )
      }

      const checkoutError = await validateConfiguredCheckout(
        this.git,
        temporaryRepository,
        repository,
        operationOptions(input, task),
      )
      if (checkoutError !== null) {
        return withInstallMetadata(
          withCommandError(initialRepositoryResult(repository), checkoutError),
          null,
          fallbackReason,
          repository.dissociate,
        )
      }

      let borrowedFromMirror = false
      if (activeLease !== null && !repository.dissociate) {
        borrowedFromMirror = await this.repoMirrorDependencies.register(
          activeLease.name,
          activeLease.path,
          temporaryRepository,
          repository.absolutePath,
        )
      }

      await mkdir(dirname(repository.absolutePath), { recursive: true })
      await rename(temporaryRepository, repository.absolutePath)
      const status = await this.git.inspect(repository, withSignal(input.signal))
      updateProgress(input, task, repository, 'installed')
      return withInstallMetadata(
        withActionResult(
          status,
          status.result === RepositoryActionResult.Failed
            ? RepositoryActionResult.Failed
            : RepositoryActionResult.Success,
        ),
        selectedMirror,
        activeLease !== null && !repository.dissociate && !borrowedFromMirror
          ? 'Git completed the clone without retaining an alternates dependency.'
          : fallbackReason,
        repository.dissociate,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return withCommandError(
        initialRepositoryResult(repository),
        commandError('install-failed', message),
      )
    } finally {
      if (activeLease !== null) await activeLease.release()
      await rm(temporaryRoot, { force: true, recursive: true })
    }
  }
}

function cloneOptions(
  input: Omit<InstallTaskInput, 'repositories'>,
  lease: RepoMirrorLease | null,
  dissociate: boolean,
  noCheckout: boolean,
  task: ConcurrentTaskReporter,
): GitCloneOptions {
  return {
    ...operationOptions(input, task),
    ...(noCheckout ? { noCheckout: true } : {}),
    ...(lease === null
      ? {}
      : { reference: { dissociate, ifAble: true as const, path: lease.path } }),
  }
}

function withInstallMetadata(
  result: RepositoryCommandResult,
  mirror: RepoMirrorLease | null,
  fallbackReason: string | undefined,
  dissociated: boolean,
): RepositoryCommandResult {
  return {
    ...result,
    ...(mirror === null ? {} : { mirror: { dissociated, name: mirror.name, path: mirror.path } }),
    ...(fallbackReason === undefined ? {} : { mirrorFallbackReason: fallbackReason }),
  }
}

function resultForExistingRepository(result: RepositoryCommandResult): RepositoryCommandResult {
  if (result.result === RepositoryActionResult.Failed) return result
  if (
    result.state === RepositoryState.SyncedLocal ||
    result.state === RepositoryState.Ahead ||
    result.state === RepositoryState.Behind ||
    result.state === RepositoryState.LocalOnly
  ) {
    return withActionResult(result, RepositoryActionResult.Skipped)
  }
  if (isConflictState(result.state)) {
    return withCommandError(
      result,
      commandError(
        'state-conflict',
        `Existing repository is ${result.state}; install will not modify it.`,
      ),
    )
  }
  return withCommandError(
    result,
    commandError('state-unavailable', 'Could not determine repository state.'),
  )
}

function canReconcileCheckout(result: RepositoryCommandResult): boolean {
  return (
    result.result !== RepositoryActionResult.Failed &&
    (result.state === RepositoryState.SyncedLocal ||
      result.state === RepositoryState.Ahead ||
      result.state === RepositoryState.Behind ||
      result.state === RepositoryState.LocalOnly)
  )
}

function operationOptions(
  input: {
    readonly interactive: boolean
    readonly jobs?: number
    readonly signal?: AbortSignal
  },
  task?: ConcurrentTaskReporter,
): GitOperationOptions {
  return {
    interactive: input.interactive && input.jobs === 1,
    ...(task?.enabled === true
      ? { onOutput: (chunk: { readonly text: string }): void => task.write(chunk.text) }
      : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  }
}

function updateProgress(
  input: Pick<InstallTaskInput, 'onProgress'>,
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
