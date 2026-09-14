import { resolve } from 'node:path'

import { Inject } from '@wendellhu/redi'

import {
  IFileSystemService,
  IGitsPathService,
  IRepoMirrorDependencyService,
  IRepoMirrorGitService,
  IRepoMirrorLoggerService,
  IRepoMirrorSchedulerService,
  type IRepoMirrorViewService,
  type RepoMirrorAction,
  type RepoMirrorDefinition,
  type RepoMirrorScheduledInvocation,
  type RepoMirrorView,
  type RepoMirrorViewOverrides,
} from '../../../contract/index'
import { nextScheduledDate } from './repoMirrorSchedule'

export class RepoMirrorViewService implements IRepoMirrorViewService {
  constructor(
    @Inject(IRepoMirrorDependencyService)
    private readonly dependencies: IRepoMirrorDependencyService,
    @Inject(IFileSystemService) private readonly fileSystem: IFileSystemService,
    @Inject(IRepoMirrorGitService) private readonly git: IRepoMirrorGitService,
    @Inject(IRepoMirrorLoggerService) private readonly logger: IRepoMirrorLoggerService,
    @Inject(IGitsPathService) private readonly paths: IGitsPathService,
    @Inject(IRepoMirrorSchedulerService) private readonly scheduler: IRepoMirrorSchedulerService,
  ) {}

  async create(
    definition: RepoMirrorDefinition,
    action: RepoMirrorAction,
    includeSize = false,
    overrides: RepoMirrorViewOverrides = {},
  ): Promise<RepoMirrorView> {
    const path = this.mirrorPath(definition.name)
    const [health, lastRun, dependents, sizeBytes, scheduler] = await Promise.all([
      this.git.inspect(definition, path),
      this.logger.readLastRun(definition.name),
      overrides.dependents === undefined
        ? this.dependencies.list(definition.name, path)
        : Promise.resolve([]),
      includeSize ? this.fileSystem.directorySize(path) : Promise.resolve(null),
      this.scheduler.inspect(definition),
    ])
    const next =
      definition.schedule === undefined ? null : nextScheduledDate(definition.schedule.cron)
    const invocation = this.scheduler.invocation(definition.name)
    return {
      action: overrides.action ?? action,
      aliases: definition.urls.slice(1),
      dependents: overrides.dependents ?? dependents.map((dependent) => dependent.repositoryPath),
      error: overrides.error ?? null,
      fetchCommand: formatInvocation(invocation),
      fetchInvocation: invocation,
      fetchUrl: definition.urls[0],
      ...(overrides.forced === undefined ? {} : { forced: overrides.forced }),
      lastRun,
      name: definition.name,
      nativeJob: scheduler.nativeJob,
      nextFetchAt: next?.toISOString() ?? null,
      path,
      projectionPath: scheduler.projectionPath,
      repositoryState: overrides.repositoryState ?? health.state,
      schedule: definition.schedule ?? null,
      scheduleState: scheduler.state,
      schedulerBackend: scheduler.backend,
      ...(scheduler.message === undefined ? {} : { schedulerMessage: scheduler.message }),
      sizeBytes,
      urls: definition.urls,
    }
  }

  mirrorPath(name: string): string {
    return resolve(this.paths.mirrors, `${name}.git`)
  }
}

function formatInvocation(invocation: RepoMirrorScheduledInvocation): string {
  const environment = Object.entries(invocation.environment)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
  return [
    ...environment,
    shellQuote(invocation.executable),
    ...invocation.arguments.map(shellQuote),
  ].join(' ')
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:=+-]+$/u.test(value)) return value
  return `'${value.replace(/'/gu, `'"'"'`)}'`
}
