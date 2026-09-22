import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

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
  RepoMirrorBusyError,
  RepoMirrorAction,
  RepoMirrorRepositoryState,
  RepoMirrorScheduleState,
  RepoMirrorUsageError,
  UnknownRepoMirrorError,
} from '../../../contract/index'
import type {
  IAddRepoMirrorService,
  AddRepoMirrorsInput,
  RepoMirrorCommandOutput,
  RepoMirrorConfiguration,
  RepoMirrorDefinition,
  RepoMirrorView,
} from '../../../contract/index'
import { pathExists, signalOptions, uniqueStrings } from '../../../util/index'
import {
  asNonEmptyUrls,
  commandError,
  moveToTrash,
  operationMessage,
  settledViews,
  validateJobs,
} from './repoMirrorHelpers'
import {
  deriveRepoMirrorName,
  resolveRepoMirrorUrl,
  validateRepoMirrorName,
} from './repoMirrorIdentity'
import type { ResolvedRepoMirrorUrl } from './repoMirrorIdentity'
import {
  createAutomaticSchedule,
  parseScheduleOption,
} from './repoMirrorSchedule'

interface AddPlan {
  readonly definition: RepoMirrorDefinition
  readonly existing: boolean
  readonly explicitSchedule: boolean
  readonly identityKey: string
  readonly identityKeys: readonly string[]
}

export class AddRepoMirrorService implements IAddRepoMirrorService {
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

  async execute(input: AddRepoMirrorsInput): Promise<RepoMirrorCommandOutput> {
    validateJobs(input.jobs)
    if (input.urls.length === 0) {
      throw new RepoMirrorUsageError('Provide at least one Git URL.')
    }
    if (input.name !== undefined) {
      validateRepoMirrorName(input.name)
    }

    const configuration = await this.store.load()
    const plans = await this.#plan(configuration, input)
    if (input.dryRun) {
      const mirrors = await Promise.all(
        plans.map(async (plan) =>
          this.view.create(
            plan.definition,
            plan.existing ? RepoMirrorAction.Updated : RepoMirrorAction.Created
          )
        )
      )
      return { command: 'repo-mirrors add', mirrors, ok: true }
    }

    const summary = await this.concurrency.run<AddPlan, RepoMirrorView>(
      plans,
      async (plan) => this.#addOne(plan, input),
      {
        ...(input.jobs === undefined ? {} : { concurrency: input.jobs }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }
    )
    const mirrors = await settledViews(summary.results, async (plan) =>
      this.view.create(plan.definition, RepoMirrorAction.NotRun, false, {
        error: commandError(
          'not-run',
          'Mirror was not created before interruption.'
        ),
      })
    )
    return {
      command: 'repo-mirrors add',
      mirrors,
      ok: mirrors.every(
        (mirror) =>
          mirror.action !== RepoMirrorAction.Failed &&
          mirror.action !== RepoMirrorAction.NotRun
      ),
    }
  }

  async #plan(
    configuration: RepoMirrorConfiguration,
    input: AddRepoMirrorsInput
  ): Promise<readonly AddPlan[]> {
    const resolved = await Promise.all(
      input.urls.map(async (url) => resolveRepoMirrorUrl(this.git, url))
    )
    const groups = new Map<string, ResolvedRepoMirrorUrl[]>()
    for (const item of resolved) {
      const group = groups.get(item.key) ?? []
      group.push(item)
      groups.set(item.key, group)
    }
    if (
      (input.name !== undefined || input.aliases.length > 0) &&
      groups.size !== 1
    ) {
      throw new RepoMirrorUsageError(
        '--name and --alias require exactly one repository identity.'
      )
    }

    const aliases = await Promise.all(
      input.aliases.map(async (url) => resolveRepoMirrorUrl(this.git, url))
    )
    const configuredIdentities =
      await this.configuration.identities(configuration)
    const installationId = await this.paths.readOrCreateInstallationId()
    const usedNames = new Set(
      configuration.repoMirrors.map((definition) => definition.name)
    )
    const plans: AddPlan[] = []

    for (const [identityKey, urls] of groups) {
      const candidates = [...urls, ...aliases]
      const owners = new Set(
        candidates
          .map((candidate) => configuredIdentities.get(candidate.key))
          .filter((owner): owner is string => owner !== undefined)
      )
      if (owners.size > 1) {
        throw new RepoMirrorUsageError(
          'The supplied URLs already belong to different mirrors.'
        )
      }
      const owner = owners.values().next().value
      const existing = configuration.repoMirrors.find(
        (definition) => definition.name === owner
      )
      if (existing !== undefined) {
        if (input.name !== undefined && input.name !== existing.name) {
          throw new RepoMirrorUsageError(
            `Repository is already mirrored as '${existing.name}', not '${input.name}'.`
          )
        }
        const combined = uniqueStrings([
          ...existing.urls,
          ...candidates.map((item) => item.original),
        ])
        const schedule =
          input.schedule === undefined
            ? existing.schedule
            : (parseScheduleOption(
                input.schedule,
                installationId,
                identityKey
              ) ?? undefined)
        plans.push({
          definition: {
            name: existing.name,
            urls: asNonEmptyUrls(combined),
            ...(schedule === undefined ? {} : { schedule }),
          },
          existing: true,
          explicitSchedule: input.schedule !== undefined,
          identityKey,
          identityKeys: uniqueStrings(
            candidates.map((candidate) => candidate.key)
          ),
        })
        continue
      }

      const [primary] = urls
      if (primary === undefined) {
        continue
      }
      const name = input.name ?? deriveRepoMirrorName(primary.identity)
      validateRepoMirrorName(name)
      if (usedNames.has(name)) {
        throw new RepoMirrorUsageError(
          `Mirror name '${name}' already exists; pass a different --name.`
        )
      }
      usedNames.add(name)
      const allUrls = uniqueStrings(
        candidates.map((candidate) => candidate.original)
      )
      const schedule =
        input.schedule === undefined
          ? createAutomaticSchedule(installationId, identityKey)
          : parseScheduleOption(input.schedule, installationId, identityKey)
      plans.push({
        definition: {
          name,
          urls: asNonEmptyUrls(allUrls),
          ...(schedule === null ? {} : { schedule }),
        },
        existing: false,
        explicitSchedule: input.schedule !== undefined,
        identityKey,
        identityKeys: uniqueStrings(
          candidates.map((candidate) => candidate.key)
        ),
      })
    }
    return plans
  }

  async #addOne(
    plan: AddPlan,
    input: AddRepoMirrorsInput
  ): Promise<RepoMirrorView> {
    const releaseMirror = await this.lock.acquireMirror(plan.definition.name, {
      wait: false,
    })
    if (releaseMirror === null) {
      throw new RepoMirrorBusyError(plan.definition.name)
    }
    try {
      if (plan.existing) {
        return await this.#updateExisting(plan)
      }

      await mkdir(this.paths.temporary, { mode: 0o700, recursive: true })
      const temporaryRoot = await mkdtemp(
        join(this.paths.temporary, `${plan.definition.name}-`)
      )
      const temporaryMirror = resolve(
        temporaryRoot,
        `${plan.definition.name}.git`
      )
      const finalPath = this.view.mirrorPath(plan.definition.name)
      try {
        if (await pathExists(finalPath)) {
          return await this.view.create(
            plan.definition,
            RepoMirrorAction.Failed,
            false,
            {
              error: commandError(
                'mirror-path-exists',
                `Mirror path already exists: ${finalPath}`
              ),
            }
          )
        }
        const cloned = await this.git.cloneMirror(
          plan.definition.urls[0],
          temporaryMirror,
          signalOptions(input.signal)
        )
        if (!cloned.ok) {
          return await this.view.create(
            plan.definition,
            RepoMirrorAction.Failed,
            false,
            {
              error: commandError(
                'mirror-clone-failed',
                operationMessage(cloned.commands)
              ),
            }
          )
        }
        const health = await this.git.inspect(plan.definition, temporaryMirror)
        if (health.state !== RepoMirrorRepositoryState.Ready) {
          return await this.view.create(
            plan.definition,
            RepoMirrorAction.Failed,
            false,
            {
              error: commandError('mirror-invalid', health.issues.join(' ')),
            }
          )
        }
        await mkdir(this.paths.mirrors, { mode: 0o700, recursive: true })
        await rename(temporaryMirror, finalPath)

        const releaseConfig = await this.lock.acquireConfig()
        try {
          const configuration = await this.store.load()
          if (
            configuration.repoMirrors.some(
              (item) => item.name === plan.definition.name
            )
          ) {
            await moveToTrash(finalPath, plan.definition.name, this.paths)
            return await this.view.create(
              plan.definition,
              RepoMirrorAction.Failed,
              false,
              {
                error: commandError(
                  'mirror-name-conflict',
                  'Mirror name was created concurrently.'
                ),
              }
            )
          }
          const identities = await this.configuration.identities(configuration)
          const conflictingIdentity = plan.identityKeys.find((key) =>
            identities.has(key)
          )
          if (conflictingIdentity !== undefined) {
            await moveToTrash(finalPath, plan.definition.name, this.paths)
            return await this.view.create(
              plan.definition,
              RepoMirrorAction.Failed,
              false,
              {
                error: commandError(
                  'mirror-url-conflict',
                  'Repository was mirrored concurrently.'
                ),
              }
            )
          }
          await this.store.save({
            ...configuration,
            repoMirrors: [...configuration.repoMirrors, plan.definition],
          })
        } catch (error) {
          if (await pathExists(finalPath)) {
            await moveToTrash(finalPath, plan.definition.name, this.paths)
          }
          throw error
        } finally {
          await releaseConfig()
        }
        if (plan.definition.schedule !== undefined) {
          const schedule = await this.scheduler.apply(plan.definition)
          if (schedule.state !== RepoMirrorScheduleState.Ready) {
            return await this.view.create(
              plan.definition,
              RepoMirrorAction.Failed,
              false,
              {
                error: commandError(
                  'scheduler-apply-failed',
                  schedule.message ?? 'Native scheduler is unavailable.'
                ),
              }
            )
          }
        }
        return await this.view.create(plan.definition, RepoMirrorAction.Created)
      } finally {
        await rm(temporaryRoot, { force: true, recursive: true })
      }
    } finally {
      await releaseMirror()
    }
  }

  async #updateExisting(plan: AddPlan): Promise<RepoMirrorView> {
    const releaseConfig = await this.lock.acquireConfig()
    let configReleased = false
    try {
      const configuration = await this.store.load()
      const current = configuration.repoMirrors.find(
        (definition) => definition.name === plan.definition.name
      )
      if (current === undefined) {
        throw new UnknownRepoMirrorError([plan.definition.name])
      }
      const desiredSchedule = plan.explicitSchedule
        ? plan.definition.schedule
        : current.schedule
      const desired: RepoMirrorDefinition = {
        name: current.name,
        urls: asNonEmptyUrls(
          uniqueStrings([...current.urls, ...plan.definition.urls])
        ),
        ...(desiredSchedule === undefined ? {} : { schedule: desiredSchedule }),
      }
      const identities = await this.configuration.identities(configuration)
      for (const identityKey of plan.identityKeys) {
        const owner = identities.get(identityKey)
        if (owner !== undefined && owner !== current.name) {
          throw new RepoMirrorUsageError(
            `Repository identity is already assigned to mirror '${owner}'.`
          )
        }
      }
      const changed =
        JSON.stringify(current.urls) !== JSON.stringify(desired.urls) ||
        (plan.explicitSchedule &&
          JSON.stringify(current.schedule) !== JSON.stringify(desired.schedule))
      if (changed) {
        await this.store.save(
          this.configuration.replace(configuration, desired)
        )
      }
      await releaseConfig()
      configReleased = true
      if (changed && plan.explicitSchedule) {
        const schedule = await this.scheduler.apply(desired)
        if (
          schedule.state !== RepoMirrorScheduleState.Ready &&
          schedule.state !== RepoMirrorScheduleState.Off
        ) {
          return await this.view.create(
            desired,
            RepoMirrorAction.Failed,
            false,
            {
              error: commandError(
                'scheduler-apply-failed',
                schedule.message ?? 'Native scheduler is unavailable.'
              ),
            }
          )
        }
      }
      return await this.view.create(
        desired,
        changed ? RepoMirrorAction.Updated : RepoMirrorAction.Unchanged
      )
    } finally {
      if (!configReleased) {
        await releaseConfig()
      }
    }
  }
}
