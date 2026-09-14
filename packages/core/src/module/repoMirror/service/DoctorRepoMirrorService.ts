import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { Inject } from '@wendellhu/redi'

import {
  type IDoctorRepoMirrorService,
  IGitsPathService,
  IRepoMirrorConfigurationService,
  IRepoMirrorDependencyService,
  IRepoMirrorGitService,
  IRepoMirrorLockService,
  IRepoMirrorSchedulerService,
  IRepoMirrorStoreService,
  IRepoMirrorViewService,
  RepoMirrorAction,
  RepoMirrorRepositoryState,
  RepoMirrorScheduleState,
  RepoMirrorUsageError,
  type DoctorRepoMirrorsInput,
  type RepoMirrorCommandOutput,
  type RepoMirrorDefinition,
  type RepoMirrorView,
} from '../../../contract/index'
import {
  commandError,
  commandMessage,
  moveToTrash,
  operationMessage,
  pathExists,
  signalOptions,
} from './repoMirrorHelpers'

export class DoctorRepoMirrorService implements IDoctorRepoMirrorService {
  constructor(
    @Inject(IRepoMirrorConfigurationService)
    private readonly configuration: IRepoMirrorConfigurationService,
    @Inject(IRepoMirrorDependencyService)
    private readonly dependencies: IRepoMirrorDependencyService,
    @Inject(IRepoMirrorGitService) private readonly git: IRepoMirrorGitService,
    @Inject(IRepoMirrorLockService) private readonly lock: IRepoMirrorLockService,
    @Inject(IGitsPathService) private readonly paths: IGitsPathService,
    @Inject(IRepoMirrorSchedulerService) private readonly scheduler: IRepoMirrorSchedulerService,
    @Inject(IRepoMirrorStoreService) private readonly store: IRepoMirrorStoreService,
    @Inject(IRepoMirrorViewService) private readonly view: IRepoMirrorViewService,
  ) {}

  async execute(input: DoctorRepoMirrorsInput): Promise<RepoMirrorCommandOutput> {
    if (input.fix && !input.confirmed) {
      throw new RepoMirrorUsageError('Repair requires confirmation or --yes.')
    }
    const configuration = await this.store.load()
    const definitions = this.configuration.select(configuration, input.names)
    const mirrors: RepoMirrorView[] = []
    for (const definition of definitions) {
      // Diagnostics are deliberately sequential so each repair is fully committed before the next.
      // eslint-disable-next-line no-await-in-loop
      mirrors.push(await this.#doctorOne(definition, input))
    }
    return {
      command: 'repo-mirrors doctor',
      mirrors,
      ok: mirrors.every((mirror) => mirror.error === null),
    }
  }

  async #doctorOne(
    definition: RepoMirrorDefinition,
    input: DoctorRepoMirrorsInput,
  ): Promise<RepoMirrorView> {
    const path = this.view.mirrorPath(definition.name)
    let health = await this.git.inspect(definition, path)
    if (health.state !== RepoMirrorRepositoryState.Ready && input.fix) {
      const repaired = await this.#repair(definition, input.signal)
      if (repaired !== null) {
        return this.view.create(definition, RepoMirrorAction.Failed, true, {
          error: commandError('mirror-repair-failed', repaired),
        })
      }
      health = await this.git.inspect(definition, path)
    }
    if (health.state !== RepoMirrorRepositoryState.Ready) {
      return this.view.create(definition, RepoMirrorAction.Failed, true, {
        error: commandError('mirror-invalid', health.issues.join(' ')),
      })
    }
    if (input.deep) {
      const checked = await this.git.fsck(path, signalOptions(input.signal))
      if (checked.aborted || checked.exitCode !== 0) {
        return this.view.create(definition, RepoMirrorAction.Failed, true, {
          error: commandError('mirror-fsck-failed', commandMessage(checked)),
        })
      }
    }
    if (input.remote) {
      const checked = await this.git.probeRemote(definition.urls[0], signalOptions(input.signal))
      if (checked.aborted || checked.exitCode !== 0) {
        return this.view.create(definition, RepoMirrorAction.Failed, true, {
          error: commandError('mirror-remote-failed', commandMessage(checked)),
        })
      }
    }
    if (input.fix && definition.schedule !== undefined) {
      const schedule = await this.scheduler.apply(definition)
      if (schedule.state !== RepoMirrorScheduleState.Ready) {
        return this.view.create(definition, RepoMirrorAction.Failed, true, {
          error: commandError(
            'scheduler-repair-failed',
            schedule.message ?? 'Native scheduler is unavailable.',
          ),
        })
      }
    }
    return this.view.create(
      definition,
      input.fix ? RepoMirrorAction.Repaired : RepoMirrorAction.Checked,
      true,
    )
  }

  async #repair(
    definition: RepoMirrorDefinition,
    signal: AbortSignal | undefined,
  ): Promise<string | null> {
    const releaseMirror = await this.lock.acquireMirror(definition.name, { wait: false })
    if (releaseMirror === null) return 'Mirror is being used by another process.'
    const path = this.view.mirrorPath(definition.name)
    try {
      const dependents = await this.dependencies.list(definition.name, path)
      if (dependents.length > 0) {
        return 'Repair is blocked while repositories borrow objects from this mirror.'
      }
      if ((await pathExists(path)) && !(await this.git.isManagedMirror(path))) {
        return `Refusing to replace a path without the gits managed marker: ${path}`
      }
      await mkdir(this.paths.temporary, { mode: 0o700, recursive: true })
      const temporaryRoot = await mkdtemp(join(this.paths.temporary, `${definition.name}-repair-`))
      const temporaryMirror = resolve(temporaryRoot, `${definition.name}.git`)
      try {
        const cloned = await this.git.cloneMirror(
          definition.urls[0],
          temporaryMirror,
          signalOptions(signal),
        )
        if (!cloned.ok) return operationMessage(cloned.commands)
        const health = await this.git.inspect(definition, temporaryMirror)
        if (health.state !== RepoMirrorRepositoryState.Ready) return health.issues.join(' ')
        if (await pathExists(path)) await moveToTrash(path, definition.name, this.paths)
        await rename(temporaryMirror, path)
        return null
      } finally {
        await rm(temporaryRoot, { force: true, recursive: true })
      }
    } finally {
      await releaseMirror()
    }
  }
}
