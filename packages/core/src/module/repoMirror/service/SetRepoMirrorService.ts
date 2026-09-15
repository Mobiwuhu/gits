import { Inject } from '@wendellhu/redi'

import {
  IConcurrencyService,
  IGitsPathService,
  IRepoMirrorConfigurationService,
  IRepoMirrorGitService,
  IRepoMirrorLockService,
  IRepoMirrorSchedulerService,
  IRepoMirrorStoreService,
  IRepoMirrorViewService,
  RepoMirrorAction,
  RepoMirrorScheduleState,
  RepoMirrorBusyError,
  RepoMirrorUsageError,
  UnknownRepoMirrorError,
} from '../../../contract/index'
import type {
  ISetRepoMirrorService,
  RepoMirrorCommandOutput,
  RepoMirrorDefinition,
  RepoMirrorView,
  SetRepoMirrorsInput,
} from '../../../contract/index'
import {
  asNonEmptyUrls,
  commandError,
  operationMessage,
  settledViews,
  signalOptions,
  uniqueStrings,
  validateJobs,
} from './repoMirrorHelpers'
import { resolveRepoMirrorUrl } from './repoMirrorIdentity'
import { parseScheduleOption } from './repoMirrorSchedule'

export class SetRepoMirrorService implements ISetRepoMirrorService {
  constructor(
    @Inject(IConcurrencyService)
    private readonly concurrency: IConcurrencyService,
    @Inject(IRepoMirrorConfigurationService)
    private readonly configuration: IRepoMirrorConfigurationService,
    @Inject(IRepoMirrorGitService) private readonly git: IRepoMirrorGitService,
    @Inject(IRepoMirrorLockService)
    private readonly lock: IRepoMirrorLockService,
    @Inject(IGitsPathService) private readonly paths: IGitsPathService,
    @Inject(IRepoMirrorSchedulerService)
    private readonly scheduler: IRepoMirrorSchedulerService,
    @Inject(IRepoMirrorStoreService)
    private readonly store: IRepoMirrorStoreService,
    @Inject(IRepoMirrorViewService)
    private readonly view: IRepoMirrorViewService
  ) {}

  async execute(input: SetRepoMirrorsInput): Promise<RepoMirrorCommandOutput> {
    validateJobs(input.jobs)
    if (input.names.length === 0) {
      throw new RepoMirrorUsageError('Specify at least one mirror name.')
    }
    if (
      input.schedule === undefined &&
      input.url === undefined &&
      input.addAliases.length === 0 &&
      input.removeAliases.length === 0
    ) {
      throw new RepoMirrorUsageError('Specify a schedule or URL change.')
    }
    if (
      input.names.length > 1 &&
      (input.url !== undefined ||
        input.addAliases.length > 0 ||
        input.removeAliases.length > 0)
    ) {
      throw new RepoMirrorUsageError(
        'URL and alias changes can target only one mirror.'
      )
    }

    const configuration = await this.store.load()
    const definitions = this.configuration.select(configuration, input.names)
    const summary = await this.concurrency.run<
      RepoMirrorDefinition,
      RepoMirrorView
    >(definitions, async (definition) => this.#setOne(definition, input), {
      ...(input.jobs === undefined ? {} : { concurrency: input.jobs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    const mirrors = await settledViews(summary.results, async (definition) =>
      this.view.create(definition, RepoMirrorAction.NotRun, false, {
        error: commandError(
          'not-run',
          'Mirror was not updated before interruption.'
        ),
      })
    )
    return {
      command: 'repo-mirrors set',
      mirrors,
      ok: mirrors.every(
        (mirror) =>
          mirror.action !== RepoMirrorAction.Failed &&
          mirror.action !== RepoMirrorAction.NotRun
      ),
    }
  }

  async #setOne(
    original: RepoMirrorDefinition,
    input: SetRepoMirrorsInput
  ): Promise<RepoMirrorView> {
    const releaseMirror = await this.lock.acquireMirror(original.name, {
      wait: false,
    })
    if (releaseMirror === null) {
      throw new RepoMirrorBusyError(original.name)
    }
    const releaseConfig = await this.lock.acquireConfig()
    let configReleased = false
    try {
      const configuration = await this.store.load()
      const current = configuration.repoMirrors.find(
        (item) => item.name === original.name
      )
      if (current === undefined) {
        throw new UnknownRepoMirrorError([original.name])
      }
      const additions = uniqueStrings(input.addAliases.map((url) => url.trim()))
      let urls = uniqueStrings([...current.urls, ...additions])
      for (const removed of input.removeAliases) {
        if (removed === current.urls[0]) {
          throw new RepoMirrorUsageError(
            `Cannot remove the active URL from '${current.name}'.`
          )
        }
        urls = urls.filter((url) => url !== removed)
      }
      if (input.url !== undefined) {
        const active = input.url.trim()
        if (!urls.includes(active)) {
          throw new RepoMirrorUsageError(
            '--url must select an existing URL or one added by --add-alias.'
          )
        }
        urls = [active, ...urls.filter((url) => url !== active)]
      }
      const [first] = urls
      if (first === undefined) {
        throw new RepoMirrorUsageError('Mirror URL list cannot be empty.')
      }

      const identities = await Promise.all(
        urls.map(async (url) => resolveRepoMirrorUrl(this.git, url))
      )
      const otherIdentities = await this.configuration.identities({
        ...configuration,
        repoMirrors: configuration.repoMirrors.filter(
          (item) => item.name !== current.name
        ),
      })
      for (const identity of identities) {
        const owner = otherIdentities.get(identity.key)
        if (owner !== undefined) {
          throw new RepoMirrorUsageError(
            `URL is already assigned to mirror '${owner}'.`
          )
        }
      }

      const installationId = await this.paths.readOrCreateInstallationId()
      const schedule =
        input.schedule === undefined
          ? current.schedule
          : (parseScheduleOption(
              input.schedule,
              installationId,
              identities[0]?.key ?? first
            ) ?? undefined)
      const updated: RepoMirrorDefinition = {
        name: current.name,
        urls: asNonEmptyUrls(urls),
        ...(schedule === undefined ? {} : { schedule }),
      }
      const changed = JSON.stringify(current) !== JSON.stringify(updated)
      if (!changed) {
        return await this.view.create(current, RepoMirrorAction.Unchanged)
      }

      if (current.urls[0] !== updated.urls[0]) {
        const changedRemote = await this.git.setFetchUrl(
          this.view.mirrorPath(current.name),
          updated.urls[0],
          signalOptions(input.signal)
        )
        if (!changedRemote.ok) {
          return await this.view.create(
            current,
            RepoMirrorAction.Failed,
            false,
            {
              error: commandError(
                'mirror-url-update-failed',
                operationMessage(changedRemote.commands)
              ),
            }
          )
        }
      }
      await this.store.save(this.configuration.replace(configuration, updated))
      await releaseConfig()
      configReleased = true
      if (input.schedule !== undefined) {
        const scheduleObservation = await this.scheduler.apply(updated)
        if (
          scheduleObservation.state !== RepoMirrorScheduleState.Ready &&
          scheduleObservation.state !== RepoMirrorScheduleState.Off
        ) {
          return await this.view.create(
            updated,
            RepoMirrorAction.Failed,
            false,
            {
              error: commandError(
                'scheduler-apply-failed',
                scheduleObservation.message ??
                  'Native scheduler is unavailable.'
              ),
            }
          )
        }
      }
      return await this.view.create(updated, RepoMirrorAction.Updated)
    } finally {
      if (!configReleased) {
        await releaseConfig()
      }
      await releaseMirror()
    }
  }
}
