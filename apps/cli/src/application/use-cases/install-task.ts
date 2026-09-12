import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type {
  GitCloneOptions,
  GitOperationOptions,
  GitRepositoryGateway,
} from '../ports/git-repository-gateway.js'
import { reportProgress, type RepositoryProgressReporter } from '../ports/progress-reporter.js'
import type { RepoMirrorDependencies } from '../ports/repo-mirror-dependencies.js'
import type { RepoMirrorLease, RepoMirrorResolver } from '../ports/repo-mirror-resolver.js'
import type { TaskConfigurationStore } from '../ports/task-configuration-store.js'
import { checkoutDiffers, validateConfiguredCheckout } from '../task/configured-checkout.js'
import { loadTaskConfiguration } from '../task/load-task-configuration.js'
import { gitCommandError, isGitCommandSuccessful } from '../task/git-result.js'
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

export interface InstallTaskInput {
  readonly interactive: boolean
  readonly jobs?: number
  readonly onProgress?: RepositoryProgressReporter
  readonly renderProgress?: boolean
  readonly repositories: readonly string[]
  readonly root: string
  readonly signal?: AbortSignal
}

export interface InstallTaskDependencies {
  readonly configurationStore: TaskConfigurationStore
  readonly git: GitRepositoryGateway
  readonly repoMirrorDependencies?: RepoMirrorDependencies
  readonly repoMirrorResolver?: RepoMirrorResolver
}

interface ExistingCheckoutPlan {
  readonly initial: RepositoryCommandResult
  readonly repository: TaskRepository
}

export async function installTask(
  dependencies: InstallTaskDependencies,
  input: InstallTaskInput,
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
  const missing = repositories.filter((_, index) => inspected[index]?.state === 'missing')
  const preflightFailures = await preflightRemotes(dependencies.git, missing, {
    interactive: input.interactive,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const installed = await installMissingRepositories(
    dependencies,
    missing,
    input,
    preflightFailures,
  )
  const checkoutPlans = repositories.flatMap((repository, index) => {
    const initial = inspected[index] as RepositoryCommandResult
    return checkoutDiffers(initial) && canReconcileCheckout(initial)
      ? [{ initial, repository }]
      : []
  })
  const reconciled = await reconcileExistingCheckouts(dependencies.git, checkoutPlans, input)
  const byName = new Map(
    [...installed, ...reconciled].map((result) => [result.name, result] as const),
  )
  const results = repositories.map((repository, index) => {
    const state = inspected[index] as RepositoryCommandResult
    return byName.get(repository.name) ?? resultForExistingRepository(state)
  })

  return {
    command: 'install',
    ok: results.every((result) => result.result !== 'failed'),
    repos: results,
  }
}

async function reconcileExistingCheckouts(
  git: GitRepositoryGateway,
  plans: readonly ExistingCheckoutPlan[],
  input: InstallTaskInput,
): Promise<readonly RepositoryCommandResult[]> {
  const summary = await runConcurrently<ExistingCheckoutPlan, RepositoryCommandResult>(
    plans,
    async (plan, _index, signal, task) => {
      const options = operationOptions({ ...input, ...(signal ? { signal } : {}) }, task)
      updateProgress(input, task, plan.repository, 'aligning checkout')
      if (plan.initial.flags.includes('dirty')) {
        return withCommandError(
          plan.initial,
          commandError(
            'dirty-worktree',
            'Commit, stash, or remove worktree changes before changing checkout directories.',
          ),
        )
      }

      const validationError = await validateConfiguredCheckout(
        git,
        plan.repository.absolutePath,
        plan.repository,
        options,
      )
      if (validationError !== null) return withCommandError(plan.initial, validationError)

      const applied = await git.applyCheckout(
        plan.repository.absolutePath,
        plan.repository.checkout,
        options,
      )
      if (!isGitCommandSuccessful(applied)) {
        return withCommandError(plan.initial, gitCommandError(applied))
      }

      const status = await git.inspect(plan.repository, withSignal(signal))
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
      return withActionResult(status, status.result === 'failed' ? 'failed' : 'success')
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
    if (entry.status === 'fulfilled') return entry.value
    if (entry.status === 'not-run') {
      return withCommandError(
        initialRepositoryResult(entry.item.repository),
        commandError('interrupted', 'Checkout was not aligned before interruption.'),
        'not-run',
      )
    }
    const message = entry.error instanceof Error ? entry.error.message : String(entry.error)
    return withCommandError(
      initialRepositoryResult(entry.item.repository),
      commandError('checkout-reconciliation-failed', message),
    )
  })
}

async function installMissingRepositories(
  dependencies: InstallTaskDependencies,
  repositories: readonly TaskRepository[],
  input: InstallTaskInput,
  preflightFailures: ReadonlyMap<string, ReturnType<typeof commandError>>,
): Promise<readonly RepositoryCommandResult[]> {
  const summary = await runConcurrently<TaskRepository, RepositoryCommandResult>(
    repositories,
    async (repository, _index, signal, task) => {
      updateProgress(input, task, repository, 'starting install')
      const preflightFailure = remoteFailureFor(preflightFailures, repository)
      if (preflightFailure) {
        return withCommandError(initialRepositoryResult(repository), preflightFailure)
      }
      return installRepository(
        dependencies,
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
      commandError('install-failed', message),
    )
  })
}

async function installRepository(
  dependencies: InstallTaskDependencies,
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
    if (dependencies.repoMirrorResolver !== undefined) {
      const resolution = await dependencies.repoMirrorResolver.resolve(repository.url)
      activeLease = resolution.lease
      selectedMirror = resolution.lease
      fallbackReason = resolution.fallbackReason
    }

    updateProgress(input, task, repository, 'cloning')
    let clone = await dependencies.git.clone(
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
      clone = await dependencies.git.clone(
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
      const applied = await dependencies.git.applyCheckout(
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
    const prepared = await dependencies.git.prepareBranch(
      temporaryRepository,
      { branch: repository.branch, from: repository.from },
      operationOptions(input, task),
    )
    if (prepared.kind === 'failed') {
      const command = prepared.commands.at(-1)
      return withCommandError(
        initialRepositoryResult(repository),
        command
          ? gitCommandError(command)
          : commandError('branch-preparation-failed', 'Could not prepare task branch.'),
      )
    }

    const checkoutError = await validateConfiguredCheckout(
      dependencies.git,
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
    if (
      activeLease !== null &&
      !repository.dissociate &&
      dependencies.repoMirrorDependencies !== undefined
    ) {
      borrowedFromMirror = await dependencies.repoMirrorDependencies.register(
        activeLease.name,
        activeLease.path,
        temporaryRepository,
        repository.absolutePath,
      )
    }

    await mkdir(dirname(repository.absolutePath), { recursive: true })
    await rename(temporaryRepository, repository.absolutePath)
    const status = await dependencies.git.inspect(repository, withSignal(input.signal))
    updateProgress(input, task, repository, 'installed')
    return withInstallMetadata(
      withActionResult(status, status.result === 'failed' ? 'failed' : 'success'),
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
  if (result.result === 'failed') return result
  if (
    result.state === 'synced-local' ||
    result.state === 'ahead' ||
    result.state === 'behind' ||
    result.state === 'local-only'
  ) {
    return withActionResult(result, 'skipped')
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
    result.result !== 'failed' &&
    (result.state === 'synced-local' ||
      result.state === 'ahead' ||
      result.state === 'behind' ||
      result.state === 'local-only')
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
