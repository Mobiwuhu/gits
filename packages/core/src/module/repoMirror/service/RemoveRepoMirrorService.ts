import { rm, statfs } from 'node:fs/promises'
import { resolve } from 'node:path'

import { Inject } from '@wendellhu/redi'

import {
  IConcurrencyService,
  IFileSystemService,
  IGitsPathService,
  IRepoMirrorConfigurationService,
  IRepoMirrorDependencyService,
  IRepoMirrorGitService,
  IRepoMirrorLockService,
  IRepoMirrorSchedulerService,
  IRepoMirrorStoreService,
  IRepoMirrorViewService,
  RepoMirrorAction,
  RepoMirrorBusyError,
  RepoMirrorRepositoryState,
  RepoMirrorScheduleState,
  RepoMirrorUsageError,
  UnknownRepoMirrorError,
} from '../../../contract/index'
import type {
  IRemoveRepoMirrorService,
  RemoveRepoMirrorsInput,
  RepoMirrorCommandOutput,
  RepoMirrorDefinition,
  RepoMirrorView,
} from '../../../contract/index'
import {
  commandError,
  moveToTrash,
  pathExists,
  settledViews,
  signalOptions,
  validateJobs,
} from './repoMirrorHelpers'

export class RemoveRepoMirrorService implements IRemoveRepoMirrorService {
  constructor(
    @Inject(IConcurrencyService)
    private readonly concurrency: IConcurrencyService,
    @Inject(IRepoMirrorConfigurationService)
    private readonly configuration: IRepoMirrorConfigurationService,
    @Inject(IRepoMirrorDependencyService)
    private readonly dependencies: IRepoMirrorDependencyService,
    @Inject(IFileSystemService) private readonly fileSystem: IFileSystemService,
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

  async execute(
    input: RemoveRepoMirrorsInput
  ): Promise<RepoMirrorCommandOutput> {
    validateJobs(input.jobs)
    if (input.names.length === 0) {
      throw new RepoMirrorUsageError('Specify at least one mirror name.')
    }
    if (input.force && input.detachDependents) {
      throw new RepoMirrorUsageError(
        '--force and --detach-dependents cannot be combined.'
      )
    }
    if (!input.confirmed) {
      throw new RepoMirrorUsageError('Removal requires confirmation or --yes.')
    }

    const configuration = await this.store.load()
    const definitions = this.configuration.select(configuration, input.names)
    const summary = await this.concurrency.run<
      RepoMirrorDefinition,
      RepoMirrorView
    >(definitions, async (definition) => this.#removeOne(definition, input), {
      ...(input.jobs === undefined ? {} : { concurrency: input.jobs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    const mirrors = await settledViews(summary.results, async (definition) =>
      this.view.create(definition, RepoMirrorAction.NotRun, false, {
        error: commandError(
          'not-run',
          'Mirror was not removed before interruption.'
        ),
      })
    )
    return {
      command: 'repo-mirrors remove',
      mirrors,
      ok: mirrors.every((mirror) => mirror.action === RepoMirrorAction.Removed),
    }
  }

  async #removeOne(
    definition: RepoMirrorDefinition,
    input: RemoveRepoMirrorsInput
  ): Promise<RepoMirrorView> {
    const releaseMirror = await this.lock.acquireMirror(definition.name, {
      wait: false,
    })
    if (releaseMirror === null) {
      throw new RepoMirrorBusyError(definition.name)
    }
    const mirrorPath = this.view.mirrorPath(definition.name)
    try {
      if (
        (await pathExists(mirrorPath)) &&
        !(await this.git.isManagedMirror(mirrorPath))
      ) {
        return await this.view.create(
          definition,
          RepoMirrorAction.Failed,
          false,
          {
            error: commandError(
              'mirror-unmanaged-path',
              `Refusing to remove a path without the gits managed marker: ${mirrorPath}`
            ),
          }
        )
      }
      const dependents = await this.dependencies.list(
        definition.name,
        mirrorPath
      )
      const dependentPaths = dependents.map(
        (dependent) => dependent.repositoryPath
      )
      if (dependents.length > 0 && !input.detachDependents && !input.force) {
        return await this.view.create(
          definition,
          RepoMirrorAction.Failed,
          false,
          {
            dependents: dependentPaths,
            error: commandError(
              'mirror-has-dependents',
              'Use --detach-dependents for a safe removal or --force to bypass protection.'
            ),
          }
        )
      }
      if (input.detachDependents) {
        const estimatedBytes =
          (await this.fileSystem.directorySize(
            resolve(mirrorPath, 'objects')
          )) ?? 0
        const filesystem = await statfs(mirrorPath)
        const availableBytes = filesystem.bavail * filesystem.bsize
        if (estimatedBytes * dependents.length > availableBytes * 0.9) {
          return await this.view.create(
            definition,
            RepoMirrorAction.Failed,
            false,
            {
              dependents: dependentPaths,
              error: commandError(
                'insufficient-disk-space',
                `Detaching may require up to ${estimatedBytes * dependents.length} bytes; only ${availableBytes} bytes are available.`
              ),
            }
          )
        }
        const detached = await this.dependencies.detachAll(
          definition.name,
          mirrorPath,
          signalOptions(input.signal)
        )
        if (detached.failures.length > 0) {
          return await this.view.create(
            definition,
            RepoMirrorAction.Failed,
            false,
            {
              dependents: detached.failures.map(
                (failure) => failure.repositoryPath
              ),
              error: commandError(
                'dependent-detach-failed',
                detached.failures
                  .map(
                    (failure) => `${failure.repositoryPath}: ${failure.message}`
                  )
                  .join(' ')
              ),
            }
          )
        }
      }

      const scheduleRemoval = await this.scheduler.remove(definition.name)
      if (scheduleRemoval.state !== RepoMirrorScheduleState.Off) {
        return await this.view.create(
          definition,
          RepoMirrorAction.Failed,
          false,
          {
            dependents: dependentPaths,
            error: commandError(
              'scheduler-remove-failed',
              scheduleRemoval.message ??
                'Could not remove native scheduler projection.'
            ),
          }
        )
      }

      const releaseConfig = await this.lock.acquireConfig()
      try {
        const configuration = await this.store.load()
        const exists = configuration.repoMirrors.some(
          (item) => item.name === definition.name
        )
        if (!exists) {
          throw new UnknownRepoMirrorError([definition.name])
        }
        await this.store.save({
          ...configuration,
          repoMirrors: configuration.repoMirrors.filter(
            (item) => item.name !== definition.name
          ),
        })
      } finally {
        await releaseConfig()
      }

      if (await pathExists(mirrorPath)) {
        await (input.purge
          ? rm(mirrorPath, { force: true, recursive: true })
          : moveToTrash(mirrorPath, definition.name, this.paths))
      }
      return await this.view.create(
        definition,
        RepoMirrorAction.Removed,
        false,
        {
          dependents: input.force ? dependentPaths : [],
          forced: input.force,
          repositoryState: RepoMirrorRepositoryState.Missing,
        }
      )
    } finally {
      await releaseMirror()
    }
  }
}
