import { Inject } from '@wendellhu/redi'

import {
  IConcurrencyService,
  type IFetchRepoMirrorService,
  IRepoMirrorConfigurationService,
  IRepoMirrorDependencyService,
  IRepoMirrorGitService,
  IRepoMirrorLockService,
  IRepoMirrorLoggerService,
  IRepoMirrorStoreService,
  IRepoMirrorViewService,
  RepoMirrorAction,
  RepoMirrorInvocationSource,
  RepoMirrorLastRunStatus,
  RepoMirrorRepositoryState,
  type FetchRepoMirrorsInput,
  type RepoMirrorCommandOutput,
  type RepoMirrorDefinition,
  type RepoMirrorView,
} from '../../../contract/index'
import {
  commandError,
  commandMessage,
  operationMessage,
  settledViews,
  signalOptions,
  validateJobs,
} from './repoMirrorHelpers'

export class FetchRepoMirrorService implements IFetchRepoMirrorService {
  constructor(
    @Inject(IConcurrencyService) private readonly concurrency: IConcurrencyService,
    @Inject(IRepoMirrorConfigurationService)
    private readonly configuration: IRepoMirrorConfigurationService,
    @Inject(IRepoMirrorDependencyService)
    private readonly dependencies: IRepoMirrorDependencyService,
    @Inject(IRepoMirrorGitService) private readonly git: IRepoMirrorGitService,
    @Inject(IRepoMirrorLockService) private readonly lock: IRepoMirrorLockService,
    @Inject(IRepoMirrorLoggerService) private readonly logger: IRepoMirrorLoggerService,
    @Inject(IRepoMirrorStoreService) private readonly store: IRepoMirrorStoreService,
    @Inject(IRepoMirrorViewService) private readonly view: IRepoMirrorViewService,
  ) {}

  async execute(input: FetchRepoMirrorsInput): Promise<RepoMirrorCommandOutput> {
    validateJobs(input.jobs)
    const configuration = await this.store.load()
    const definitions = this.configuration.select(configuration, input.names)
    const effectiveJobs = Math.min(
      input.jobs ?? 4,
      configuration.repoMirrorsSettings.maxConcurrentFetches,
    )
    const summary = await this.concurrency.run<RepoMirrorDefinition, RepoMirrorView>(
      definitions,
      async (definition) =>
        this.#fetchOne(definition, configuration.repoMirrorsSettings.maxConcurrentFetches, input),
      {
        concurrency: effectiveJobs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    )
    const mirrors = await settledViews(summary.results, (definition) =>
      this.view.create(definition, RepoMirrorAction.NotRun, false, {
        error: commandError('not-run', 'Mirror was not fetched before interruption.'),
      }),
    )
    return {
      command: 'repo-mirrors fetch',
      mirrors,
      ok: mirrors.every(
        (mirror) =>
          mirror.action !== RepoMirrorAction.Failed && mirror.action !== RepoMirrorAction.NotRun,
      ),
    }
  }

  async #fetchOne(
    definition: RepoMirrorDefinition,
    maximumSlots: number,
    input: FetchRepoMirrorsInput,
  ): Promise<RepoMirrorView> {
    const session = await this.logger.start(definition.name, input.source)
    let sessionFinished = false
    const finish = async (...arguments_: Parameters<typeof session.finish>) => {
      sessionFinished = true
      return session.finish(...arguments_)
    }

    let releaseSlot: (() => Promise<void>) | null = null
    let releaseMirror: (() => Promise<void>) | null = null
    try {
      releaseSlot = await this.lock.acquireFetchSlot(maximumSlots, {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        wait: input.source === RepoMirrorInvocationSource.Manual,
      })
      if (releaseSlot === null) {
        await finish(RepoMirrorLastRunStatus.SkippedLocked, {
          error: 'No machine fetch slot was available.',
        })
        return this.view.create(
          definition,
          input.source === RepoMirrorInvocationSource.Scheduler
            ? RepoMirrorAction.Skipped
            : RepoMirrorAction.Failed,
          false,
          {
            error:
              input.source === RepoMirrorInvocationSource.Scheduler
                ? null
                : commandError('fetch-slots-busy', 'No machine fetch slot was available.'),
          },
        )
      }

      releaseMirror = await this.lock.acquireMirror(definition.name, { wait: false })
      if (releaseMirror === null) {
        await finish(RepoMirrorLastRunStatus.SkippedLocked, { error: 'Mirror is busy.' })
        return this.view.create(
          definition,
          input.source === RepoMirrorInvocationSource.Scheduler
            ? RepoMirrorAction.Skipped
            : RepoMirrorAction.Failed,
          false,
          {
            error:
              input.source === RepoMirrorInvocationSource.Scheduler
                ? null
                : commandError('mirror-busy', 'Mirror is being used by another process.'),
          },
        )
      }
      const path = this.view.mirrorPath(definition.name)
      const health = await this.git.inspect(definition, path)
      if (health.state !== RepoMirrorRepositoryState.Ready) {
        await finish(RepoMirrorLastRunStatus.Failed, { error: health.issues.join(' ') })
        return this.view.create(definition, RepoMirrorAction.Failed, false, {
          error: commandError('mirror-invalid', health.issues.join(' ')),
        })
      }
      const fetched = await this.git.fetchMirror(path, signalOptions(input.signal))
      for (const command of fetched.commands) session.event(command)
      if (!fetched.ok) {
        const message = operationMessage(fetched.commands)
        await finish(
          input.signal?.aborted === true
            ? RepoMirrorLastRunStatus.Interrupted
            : RepoMirrorLastRunStatus.Failed,
          { error: message },
        )
        return this.view.create(definition, RepoMirrorAction.Failed, false, {
          error: commandError('mirror-fetch-failed', message),
        })
      }
      if (input.maintenance) {
        const dependents = await this.dependencies.list(definition.name, path)
        if (dependents.length > 0) {
          const message =
            'Maintenance is blocked while repositories borrow objects from this mirror.'
          await finish(RepoMirrorLastRunStatus.Failed, { error: message })
          return this.view.create(definition, RepoMirrorAction.Failed, false, {
            dependents: dependents.map((dependent) => dependent.repositoryPath),
            error: commandError('mirror-has-dependents', message),
          })
        }
        const maintained = await this.git.maintainMirror(path, signalOptions(input.signal))
        session.event(maintained)
        if (maintained.aborted || maintained.exitCode !== 0) {
          const message = commandMessage(maintained)
          await finish(RepoMirrorLastRunStatus.Failed, { error: message })
          return this.view.create(definition, RepoMirrorAction.Failed, false, {
            error: commandError('mirror-maintenance-failed', message),
          })
        }
      }
      await finish(RepoMirrorLastRunStatus.Success)
      return this.view.create(definition, RepoMirrorAction.Fetched)
    } catch (error) {
      if (!sessionFinished) {
        sessionFinished = true
        const message = error instanceof Error ? error.message : String(error)
        await session
          .finish(
            input.signal?.aborted === true
              ? RepoMirrorLastRunStatus.Interrupted
              : RepoMirrorLastRunStatus.Failed,
            { error: message },
          )
          .catch(() => undefined)
      }
      throw error
    } finally {
      if (releaseMirror !== null) await releaseMirror()
      if (releaseSlot !== null) await releaseSlot()
    }
  }
}
