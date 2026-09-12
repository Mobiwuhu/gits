import { mkdir, mkdtemp, rename, rm, stat, statfs } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { RepoMirrorDependencies } from '../ports/repo-mirror-dependencies.js'
import type { RepoMirrorGateway } from '../ports/repo-mirror-gateway.js'
import type { RepoMirrorLock } from '../ports/repo-mirror-lock.js'
import type { RepoMirrorLogger } from '../ports/repo-mirror-logger.js'
import type { RepoMirrorStore } from '../ports/repo-mirror-store.js'
import type { RepoMirrorScheduler } from '../ports/repo-mirror-scheduler.js'
import { runConcurrently } from '../../infrastructure/concurrency/concurrent-runner.js'
import { directorySize } from '../../infrastructure/filesystem/directory-size.js'
import type { GitsPaths } from '../../infrastructure/repo-mirrors/gits-paths.js'
import { readOrCreateInstallationId } from '../../infrastructure/repo-mirrors/gits-paths.js'
import {
  RepoMirrorBusyError,
  RepoMirrorUsageError,
  UnknownRepoMirrorError,
} from '../../domain/repo-mirror/errors.js'
import type {
  RepoMirrorAction,
  RepoMirrorCommandError,
  RepoMirrorCommandOutput,
  RepoMirrorConfiguration,
  RepoMirrorDefinition,
  RepoMirrorView,
} from '../../domain/repo-mirror/model.js'
import {
  createAutomaticSchedule,
  nextScheduledDate,
  parseScheduleOption,
} from '../../domain/repo-mirror/schedule.js'
import {
  deriveRepoMirrorName,
  resolveRepoMirrorUrl,
  validateRepoMirrorName,
  type ResolvedRepoMirrorUrl,
} from './repo-mirror-identity.js'

export interface RepoMirrorManagerDependencies {
  readonly dependencies: RepoMirrorDependencies
  readonly gateway: RepoMirrorGateway
  readonly lock: RepoMirrorLock
  readonly logger: RepoMirrorLogger
  readonly paths: GitsPaths
  readonly scheduler: RepoMirrorScheduler
  readonly store: RepoMirrorStore
}

export interface ListRepoMirrorsInput {
  readonly includeSize?: boolean
  readonly names: readonly string[]
}

export interface AddRepoMirrorsInput {
  readonly aliases: readonly string[]
  readonly dryRun: boolean
  readonly jobs?: number
  readonly name?: string
  readonly schedule?: string
  readonly signal?: AbortSignal
  readonly urls: readonly string[]
}

export interface SetRepoMirrorsInput {
  readonly addAliases: readonly string[]
  readonly jobs?: number
  readonly names: readonly string[]
  readonly removeAliases: readonly string[]
  readonly schedule?: string
  readonly signal?: AbortSignal
  readonly url?: string
}

export interface FetchRepoMirrorsInput {
  readonly jobs?: number
  readonly maintenance: boolean
  readonly names: readonly string[]
  readonly signal?: AbortSignal
  readonly source: 'manual' | 'scheduler'
}

export interface RemoveRepoMirrorsInput {
  readonly confirmed: boolean
  readonly detachDependents: boolean
  readonly force: boolean
  readonly jobs?: number
  readonly names: readonly string[]
  readonly purge: boolean
  readonly signal?: AbortSignal
}

export interface DoctorRepoMirrorsInput {
  readonly confirmed: boolean
  readonly deep: boolean
  readonly fix: boolean
  readonly names: readonly string[]
  readonly remote: boolean
  readonly signal?: AbortSignal
}

interface AddPlan {
  readonly definition: RepoMirrorDefinition
  readonly existing: boolean
  readonly explicitSchedule: boolean
  readonly identityKey: string
  readonly identityKeys: readonly string[]
}

interface ViewOverrides {
  readonly action?: RepoMirrorAction
  readonly dependents?: readonly string[]
  readonly error?: RepoMirrorCommandError | null
  readonly forced?: boolean
  readonly repositoryState?: RepoMirrorView['repositoryState']
}

export class RepoMirrorManager {
  readonly #dependencies: RepoMirrorDependencies
  readonly #gateway: RepoMirrorGateway
  readonly #lock: RepoMirrorLock
  readonly #logger: RepoMirrorLogger
  readonly #paths: GitsPaths
  readonly #scheduler: RepoMirrorScheduler
  readonly #store: RepoMirrorStore

  constructor(dependencies: RepoMirrorManagerDependencies) {
    this.#dependencies = dependencies.dependencies
    this.#gateway = dependencies.gateway
    this.#lock = dependencies.lock
    this.#logger = dependencies.logger
    this.#paths = dependencies.paths
    this.#scheduler = dependencies.scheduler
    this.#store = dependencies.store
  }

  async list(input: ListRepoMirrorsInput): Promise<RepoMirrorCommandOutput> {
    const configuration = await this.#store.load()
    const definitions = selectDefinitions(configuration, input.names)
    const mirrors = await Promise.all(
      definitions.map((definition) => this.view(definition, 'checked', input.includeSize === true)),
    )
    return { command: 'repo-mirrors list', mirrors, ok: true }
  }

  async path(name: string): Promise<string> {
    validateRepoMirrorName(name)
    const configuration = await this.#store.load()
    selectDefinitions(configuration, [name])
    return this.mirrorPath(name)
  }

  async logs(name: string, lines: number): Promise<readonly string[]> {
    validateRepoMirrorName(name)
    const configuration = await this.#store.load()
    selectDefinitions(configuration, [name])
    return this.#logger.readLines(name, lines)
  }

  async *followLogs(
    name: string,
    lines: number,
    signal: AbortSignal,
  ): AsyncGenerator<string, void> {
    validateRepoMirrorName(name)
    const configuration = await this.#store.load()
    selectDefinitions(configuration, [name])
    let previous = [...(await this.#logger.readLines(name, lines))]
    for (const line of previous) yield line

    while (!signal.aborted) {
      await abortableDelay(500, signal)
      if (signal.aborted) break
      const current = [...(await this.#logger.readLines(name, lines))]
      const overlap = suffixPrefixOverlap(previous, current)
      for (const line of current.slice(overlap)) yield line
      previous = current
    }
  }

  async add(input: AddRepoMirrorsInput): Promise<RepoMirrorCommandOutput> {
    validateJobs(input.jobs)
    if (input.urls.length === 0) throw new RepoMirrorUsageError('Provide at least one Git URL.')
    if (input.name !== undefined) validateRepoMirrorName(input.name)

    const configuration = await this.#store.load()
    const plans = await this.planAdd(configuration, input)
    if (input.dryRun) {
      const mirrors = await Promise.all(
        plans.map((plan) => this.view(plan.definition, plan.existing ? 'updated' : 'created')),
      )
      return { command: 'repo-mirrors add', mirrors, ok: true }
    }

    const summary = await runConcurrently<AddPlan, RepoMirrorView>(
      plans,
      async (plan) => this.addOne(plan, input),
      {
        ...(input.jobs === undefined ? {} : { concurrency: input.jobs }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    )
    const mirrors = await settledViews(summary.results, (plan) =>
      this.view(plan.definition, 'not-run', false, {
        error: commandError('not-run', 'Mirror was not created before interruption.'),
      }),
    )
    return {
      command: 'repo-mirrors add',
      mirrors,
      ok: mirrors.every((mirror) => mirror.action !== 'failed' && mirror.action !== 'not-run'),
    }
  }

  async set(input: SetRepoMirrorsInput): Promise<RepoMirrorCommandOutput> {
    validateJobs(input.jobs)
    if (input.names.length === 0)
      throw new RepoMirrorUsageError('Specify at least one mirror name.')
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
      (input.url !== undefined || input.addAliases.length > 0 || input.removeAliases.length > 0)
    ) {
      throw new RepoMirrorUsageError('URL and alias changes can target only one mirror.')
    }

    const configuration = await this.#store.load()
    const definitions = selectDefinitions(configuration, input.names)
    const summary = await runConcurrently<RepoMirrorDefinition, RepoMirrorView>(
      definitions,
      async (definition) => this.setOne(definition, input),
      {
        ...(input.jobs === undefined ? {} : { concurrency: input.jobs }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    )
    const mirrors = await settledViews(summary.results, (definition) =>
      this.view(definition, 'not-run', false, {
        error: commandError('not-run', 'Mirror was not updated before interruption.'),
      }),
    )
    return {
      command: 'repo-mirrors set',
      mirrors,
      ok: mirrors.every((mirror) => mirror.action !== 'failed' && mirror.action !== 'not-run'),
    }
  }

  async fetch(input: FetchRepoMirrorsInput): Promise<RepoMirrorCommandOutput> {
    validateJobs(input.jobs)
    const configuration = await this.#store.load()
    const definitions = selectDefinitions(configuration, input.names)
    const effectiveJobs = Math.min(
      input.jobs ?? 4,
      configuration.repoMirrorsSettings.maxConcurrentFetches,
    )
    const summary = await runConcurrently<RepoMirrorDefinition, RepoMirrorView>(
      definitions,
      async (definition) =>
        this.fetchOne(definition, configuration.repoMirrorsSettings.maxConcurrentFetches, input),
      {
        concurrency: effectiveJobs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    )
    const mirrors = await settledViews(summary.results, (definition) =>
      this.view(definition, 'not-run', false, {
        error: commandError('not-run', 'Mirror was not fetched before interruption.'),
      }),
    )
    return {
      command: 'repo-mirrors fetch',
      mirrors,
      ok: mirrors.every((mirror) => mirror.action !== 'failed' && mirror.action !== 'not-run'),
    }
  }

  async remove(input: RemoveRepoMirrorsInput): Promise<RepoMirrorCommandOutput> {
    validateJobs(input.jobs)
    if (input.names.length === 0)
      throw new RepoMirrorUsageError('Specify at least one mirror name.')
    if (input.force && input.detachDependents) {
      throw new RepoMirrorUsageError('--force and --detach-dependents cannot be combined.')
    }
    if (!input.confirmed) throw new RepoMirrorUsageError('Removal requires confirmation or --yes.')

    const configuration = await this.#store.load()
    const definitions = selectDefinitions(configuration, input.names)
    const summary = await runConcurrently<RepoMirrorDefinition, RepoMirrorView>(
      definitions,
      async (definition) => this.removeOne(definition, input),
      {
        ...(input.jobs === undefined ? {} : { concurrency: input.jobs }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    )
    const mirrors = await settledViews(summary.results, (definition) =>
      this.view(definition, 'not-run', false, {
        error: commandError('not-run', 'Mirror was not removed before interruption.'),
      }),
    )
    return {
      command: 'repo-mirrors remove',
      mirrors,
      ok: mirrors.every((mirror) => mirror.action === 'removed'),
    }
  }

  async doctor(input: DoctorRepoMirrorsInput): Promise<RepoMirrorCommandOutput> {
    if (input.fix && !input.confirmed) {
      throw new RepoMirrorUsageError('Repair requires confirmation or --yes.')
    }
    const configuration = await this.#store.load()
    const definitions = selectDefinitions(configuration, input.names)
    const mirrors: RepoMirrorView[] = []
    for (const definition of definitions) {
      mirrors.push(await this.doctorOne(definition, input))
    }
    return {
      command: 'repo-mirrors doctor',
      mirrors,
      ok: mirrors.every((mirror) => mirror.error === null),
    }
  }

  async planAdd(
    configuration: RepoMirrorConfiguration,
    input: AddRepoMirrorsInput,
  ): Promise<readonly AddPlan[]> {
    const resolved = await Promise.all(
      input.urls.map((url) => resolveRepoMirrorUrl(this.#gateway, url)),
    )
    const groups = new Map<string, ResolvedRepoMirrorUrl[]>()
    for (const item of resolved) {
      const group = groups.get(item.key) ?? []
      group.push(item)
      groups.set(item.key, group)
    }
    if ((input.name !== undefined || input.aliases.length > 0) && groups.size !== 1) {
      throw new RepoMirrorUsageError('--name and --alias require exactly one repository identity.')
    }

    const aliases = await Promise.all(
      input.aliases.map((url) => resolveRepoMirrorUrl(this.#gateway, url)),
    )
    const configuredIdentities = await this.configurationIdentities(configuration)
    const installationId = await readOrCreateInstallationId(this.#paths)
    const usedNames = new Set(configuration.repoMirrors.map((definition) => definition.name))
    const plans: AddPlan[] = []

    for (const [identityKey, urls] of groups) {
      const candidates = [...urls, ...aliases]
      const owners = new Set(
        candidates
          .map((candidate) => configuredIdentities.get(candidate.key))
          .filter((owner): owner is string => owner !== undefined),
      )
      if (owners.size > 1) {
        throw new RepoMirrorUsageError('The supplied URLs already belong to different mirrors.')
      }
      const owner = owners.values().next().value as string | undefined
      const existing = configuration.repoMirrors.find((definition) => definition.name === owner)
      if (existing !== undefined) {
        if (input.name !== undefined && input.name !== existing.name) {
          throw new RepoMirrorUsageError(
            `Repository is already mirrored as '${existing.name}', not '${input.name}'.`,
          )
        }
        const combined = uniqueStrings([
          ...existing.urls,
          ...candidates.map((item) => item.original),
        ])
        const first = combined[0]
        if (first === undefined) throw new RepoMirrorUsageError('Mirror URL list cannot be empty.')
        const schedule =
          input.schedule === undefined
            ? existing.schedule
            : (parseScheduleOption(input.schedule, installationId, identityKey) ?? undefined)
        plans.push({
          definition: {
            name: existing.name,
            urls: [first, ...combined.slice(1)],
            ...(schedule === undefined ? {} : { schedule }),
          },
          existing: true,
          explicitSchedule: input.schedule !== undefined,
          identityKey,
          identityKeys: uniqueStrings(candidates.map((candidate) => candidate.key)),
        })
        continue
      }

      const primary = urls[0]
      if (primary === undefined) continue
      const name = input.name ?? deriveRepoMirrorName(primary.identity)
      validateRepoMirrorName(name)
      if (usedNames.has(name)) {
        throw new RepoMirrorUsageError(
          `Mirror name '${name}' already exists; pass a different --name.`,
        )
      }
      usedNames.add(name)
      const allUrls = uniqueStrings(candidates.map((candidate) => candidate.original))
      const first = allUrls[0]
      if (first === undefined) continue
      const schedule =
        input.schedule === undefined
          ? createAutomaticSchedule(installationId, identityKey)
          : parseScheduleOption(input.schedule, installationId, identityKey)
      plans.push({
        definition: {
          name,
          urls: [first, ...allUrls.slice(1)],
          ...(schedule === null ? {} : { schedule }),
        },
        existing: false,
        explicitSchedule: input.schedule !== undefined,
        identityKey,
        identityKeys: uniqueStrings(candidates.map((candidate) => candidate.key)),
      })
    }
    return plans
  }

  async addOne(plan: AddPlan, input: AddRepoMirrorsInput): Promise<RepoMirrorView> {
    const releaseMirror = await this.#lock.acquireMirror(plan.definition.name, { wait: false })
    if (releaseMirror === null) throw new RepoMirrorBusyError(plan.definition.name)
    try {
      if (plan.existing) {
        const releaseConfig = await this.#lock.acquireConfig()
        let configReleased = false
        try {
          const configuration = await this.#store.load()
          const current = configuration.repoMirrors.find(
            (definition) => definition.name === plan.definition.name,
          )
          if (current === undefined) throw new UnknownRepoMirrorError([plan.definition.name])
          const desired: RepoMirrorDefinition = {
            name: current.name,
            urls: asNonEmptyUrls(uniqueStrings([...current.urls, ...plan.definition.urls])),
            ...(plan.explicitSchedule
              ? plan.definition.schedule === undefined
                ? {}
                : { schedule: plan.definition.schedule }
              : current.schedule === undefined
                ? {}
                : { schedule: current.schedule }),
          }
          const identities = await this.configurationIdentities(configuration)
          for (const identityKey of plan.identityKeys) {
            const owner = identities.get(identityKey)
            if (owner !== undefined && owner !== current.name) {
              throw new RepoMirrorUsageError(
                `Repository identity is already assigned to mirror '${owner}'.`,
              )
            }
          }
          const changed =
            JSON.stringify(current.urls) !== JSON.stringify(desired.urls) ||
            (plan.explicitSchedule &&
              JSON.stringify(current.schedule) !== JSON.stringify(desired.schedule))
          if (changed) {
            await this.#store.save(replaceDefinition(configuration, desired))
          }
          await releaseConfig()
          configReleased = true
          if (changed && plan.explicitSchedule) {
            const schedule = await this.#scheduler.apply(desired)
            if (schedule.state !== 'ready' && schedule.state !== 'off') {
              return this.view(desired, 'failed', false, {
                error: commandError(
                  'scheduler-apply-failed',
                  schedule.message ?? 'Native scheduler is unavailable.',
                ),
              })
            }
          }
          return this.view(desired, changed ? 'updated' : 'unchanged')
        } finally {
          if (!configReleased) await releaseConfig()
        }
      }

      await mkdir(this.#paths.temporary, { mode: 0o700, recursive: true })
      const temporaryRoot = await mkdtemp(join(this.#paths.temporary, `${plan.definition.name}-`))
      const temporaryMirror = resolve(temporaryRoot, `${plan.definition.name}.git`)
      const finalPath = this.mirrorPath(plan.definition.name)
      try {
        if (await pathExists(finalPath)) {
          return this.view(plan.definition, 'failed', false, {
            error: commandError('mirror-path-exists', `Mirror path already exists: ${finalPath}`),
          })
        }
        const cloned = await this.#gateway.cloneMirror(
          plan.definition.urls[0],
          temporaryMirror,
          signalOptions(input.signal),
        )
        if (!cloned.ok) {
          return this.view(plan.definition, 'failed', false, {
            error: commandError('mirror-clone-failed', operationMessage(cloned.commands)),
          })
        }
        const health = await this.#gateway.inspect(plan.definition, temporaryMirror)
        if (health.state !== 'ready') {
          return this.view(plan.definition, 'failed', false, {
            error: commandError('mirror-invalid', health.issues.join(' ')),
          })
        }
        await mkdir(this.#paths.mirrors, { mode: 0o700, recursive: true })
        await rename(temporaryMirror, finalPath)

        const releaseConfig = await this.#lock.acquireConfig()
        try {
          const configuration = await this.#store.load()
          if (configuration.repoMirrors.some((item) => item.name === plan.definition.name)) {
            await moveToTrash(finalPath, plan.definition.name, this.#paths)
            return this.view(plan.definition, 'failed', false, {
              error: commandError('mirror-name-conflict', 'Mirror name was created concurrently.'),
            })
          }
          const identities = await this.configurationIdentities(configuration)
          const conflictingIdentity = plan.identityKeys.find((key) => identities.has(key))
          if (conflictingIdentity !== undefined) {
            await moveToTrash(finalPath, plan.definition.name, this.#paths)
            return this.view(plan.definition, 'failed', false, {
              error: commandError('mirror-url-conflict', 'Repository was mirrored concurrently.'),
            })
          }
          await this.#store.save({
            ...configuration,
            repoMirrors: [...configuration.repoMirrors, plan.definition],
          })
        } catch (error) {
          if (await pathExists(finalPath))
            await moveToTrash(finalPath, plan.definition.name, this.#paths)
          throw error
        } finally {
          await releaseConfig()
        }
        if (plan.definition.schedule !== undefined) {
          const schedule = await this.#scheduler.apply(plan.definition)
          if (schedule.state !== 'ready') {
            return this.view(plan.definition, 'failed', false, {
              error: commandError(
                'scheduler-apply-failed',
                schedule.message ?? 'Native scheduler is unavailable.',
              ),
            })
          }
        }
        return this.view(plan.definition, 'created')
      } finally {
        await rm(temporaryRoot, { force: true, recursive: true })
      }
    } finally {
      await releaseMirror()
    }
  }

  async setOne(
    original: RepoMirrorDefinition,
    input: SetRepoMirrorsInput,
  ): Promise<RepoMirrorView> {
    const releaseMirror = await this.#lock.acquireMirror(original.name, { wait: false })
    if (releaseMirror === null) throw new RepoMirrorBusyError(original.name)
    const releaseConfig = await this.#lock.acquireConfig()
    let configReleased = false
    try {
      const configuration = await this.#store.load()
      const current = configuration.repoMirrors.find((item) => item.name === original.name)
      if (current === undefined) throw new UnknownRepoMirrorError([original.name])
      const additions = uniqueStrings(input.addAliases.map((url) => url.trim()))
      let urls = uniqueStrings([...current.urls, ...additions])
      for (const removed of input.removeAliases) {
        if (removed === current.urls[0]) {
          throw new RepoMirrorUsageError(`Cannot remove the active URL from '${current.name}'.`)
        }
        urls = urls.filter((url) => url !== removed)
      }
      if (input.url !== undefined) {
        const active = input.url.trim()
        if (!urls.includes(active)) {
          throw new RepoMirrorUsageError(
            '--url must select an existing URL or one added by --add-alias.',
          )
        }
        urls = [active, ...urls.filter((url) => url !== active)]
      }
      const first = urls[0]
      if (first === undefined) throw new RepoMirrorUsageError('Mirror URL list cannot be empty.')

      const identities = await Promise.all(
        urls.map((url) => resolveRepoMirrorUrl(this.#gateway, url)),
      )
      const otherIdentities = await this.configurationIdentities({
        ...configuration,
        repoMirrors: configuration.repoMirrors.filter((item) => item.name !== current.name),
      })
      for (const identity of identities) {
        const owner = otherIdentities.get(identity.key)
        if (owner !== undefined) {
          throw new RepoMirrorUsageError(`URL is already assigned to mirror '${owner}'.`)
        }
      }

      const installationId = await readOrCreateInstallationId(this.#paths)
      const schedule =
        input.schedule === undefined
          ? current.schedule
          : (parseScheduleOption(input.schedule, installationId, identities[0]?.key ?? first) ??
            undefined)
      const updated: RepoMirrorDefinition = {
        name: current.name,
        urls: [first, ...urls.slice(1)],
        ...(schedule === undefined ? {} : { schedule }),
      }
      const changed = JSON.stringify(current) !== JSON.stringify(updated)
      if (!changed) return this.view(current, 'unchanged')

      if (current.urls[0] !== updated.urls[0]) {
        const changedRemote = await this.#gateway.setFetchUrl(
          this.mirrorPath(current.name),
          updated.urls[0],
          signalOptions(input.signal),
        )
        if (!changedRemote.ok) {
          return this.view(current, 'failed', false, {
            error: commandError(
              'mirror-url-update-failed',
              operationMessage(changedRemote.commands),
            ),
          })
        }
      }
      await this.#store.save(replaceDefinition(configuration, updated))
      await releaseConfig()
      configReleased = true
      if (input.schedule !== undefined) {
        const scheduleObservation = await this.#scheduler.apply(updated)
        if (scheduleObservation.state !== 'ready' && scheduleObservation.state !== 'off') {
          return this.view(updated, 'failed', false, {
            error: commandError(
              'scheduler-apply-failed',
              scheduleObservation.message ?? 'Native scheduler is unavailable.',
            ),
          })
        }
      }
      return this.view(updated, 'updated')
    } finally {
      if (!configReleased) await releaseConfig()
      await releaseMirror()
    }
  }

  async fetchOne(
    definition: RepoMirrorDefinition,
    maximumSlots: number,
    input: FetchRepoMirrorsInput,
  ): Promise<RepoMirrorView> {
    const session = await this.#logger.start(definition.name, input.source)
    let sessionFinished = false
    const finish = async (...arguments_: Parameters<typeof session.finish>) => {
      sessionFinished = true
      return session.finish(...arguments_)
    }

    let releaseSlot: (() => Promise<void>) | null = null
    let releaseMirror: (() => Promise<void>) | null = null
    try {
      releaseSlot = await this.#lock.acquireFetchSlot(maximumSlots, {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        wait: input.source === 'manual',
      })
      if (releaseSlot === null) {
        await finish('skipped-locked', { error: 'No machine fetch slot was available.' })
        return this.view(definition, input.source === 'scheduler' ? 'skipped' : 'failed', false, {
          error:
            input.source === 'scheduler'
              ? null
              : commandError('fetch-slots-busy', 'No machine fetch slot was available.'),
        })
      }

      releaseMirror = await this.#lock.acquireMirror(definition.name, { wait: false })
      if (releaseMirror === null) {
        await finish('skipped-locked', { error: 'Mirror is busy.' })
        return this.view(definition, input.source === 'scheduler' ? 'skipped' : 'failed', false, {
          error:
            input.source === 'scheduler'
              ? null
              : commandError('mirror-busy', 'Mirror is being used by another process.'),
        })
      }
      const health = await this.#gateway.inspect(definition, this.mirrorPath(definition.name))
      if (health.state !== 'ready') {
        await finish('failed', { error: health.issues.join(' ') })
        return this.view(definition, 'failed', false, {
          error: commandError('mirror-invalid', health.issues.join(' ')),
        })
      }
      const fetched = await this.#gateway.fetchMirror(
        this.mirrorPath(definition.name),
        signalOptions(input.signal),
      )
      for (const command of fetched.commands) session.event(command)
      if (!fetched.ok) {
        const message = operationMessage(fetched.commands)
        await finish(input.signal?.aborted === true ? 'interrupted' : 'failed', {
          error: message,
        })
        return this.view(definition, 'failed', false, {
          error: commandError('mirror-fetch-failed', message),
        })
      }
      if (input.maintenance) {
        const dependents = await this.#dependencies.list(
          definition.name,
          this.mirrorPath(definition.name),
        )
        if (dependents.length > 0) {
          const message =
            'Maintenance is blocked while repositories borrow objects from this mirror.'
          await finish('failed', { error: message })
          return this.view(definition, 'failed', false, {
            dependents: dependents.map((dependent) => dependent.repositoryPath),
            error: commandError('mirror-has-dependents', message),
          })
        }
        const maintained = await this.#gateway.maintainMirror(
          this.mirrorPath(definition.name),
          signalOptions(input.signal),
        )
        session.event(maintained)
        if (maintained.aborted || maintained.exitCode !== 0) {
          const message = commandMessage(maintained)
          await finish('failed', { error: message })
          return this.view(definition, 'failed', false, {
            error: commandError('mirror-maintenance-failed', message),
          })
        }
      }
      await finish('success')
      return this.view(definition, 'fetched')
    } catch (error) {
      if (!sessionFinished) {
        sessionFinished = true
        const message = error instanceof Error ? error.message : String(error)
        await session
          .finish(input.signal?.aborted === true ? 'interrupted' : 'failed', { error: message })
          .catch(() => undefined)
      }
      throw error
    } finally {
      if (releaseMirror !== null) await releaseMirror()
      if (releaseSlot !== null) await releaseSlot()
    }
  }

  async removeOne(
    definition: RepoMirrorDefinition,
    input: RemoveRepoMirrorsInput,
  ): Promise<RepoMirrorView> {
    const releaseMirror = await this.#lock.acquireMirror(definition.name, { wait: false })
    if (releaseMirror === null) throw new RepoMirrorBusyError(definition.name)
    const mirrorPath = this.mirrorPath(definition.name)
    try {
      if ((await pathExists(mirrorPath)) && !(await this.#gateway.isManagedMirror(mirrorPath))) {
        return this.view(definition, 'failed', false, {
          error: commandError(
            'mirror-unmanaged-path',
            `Refusing to remove a path without the gits managed marker: ${mirrorPath}`,
          ),
        })
      }
      const dependents = await this.#dependencies.list(definition.name, mirrorPath)
      const dependentPaths = dependents.map((dependent) => dependent.repositoryPath)
      if (dependents.length > 0 && !input.detachDependents && !input.force) {
        return this.view(definition, 'failed', false, {
          dependents: dependentPaths,
          error: commandError(
            'mirror-has-dependents',
            'Use --detach-dependents for a safe removal or --force to bypass protection.',
          ),
        })
      }
      if (input.detachDependents) {
        const estimatedBytes = (await directorySize(resolve(mirrorPath, 'objects'))) ?? 0
        const filesystem = await statfs(mirrorPath)
        const availableBytes = filesystem.bavail * filesystem.bsize
        if (estimatedBytes * dependents.length > availableBytes * 0.9) {
          return this.view(definition, 'failed', false, {
            dependents: dependentPaths,
            error: commandError(
              'insufficient-disk-space',
              `Detaching may require up to ${estimatedBytes * dependents.length} bytes; only ${availableBytes} bytes are available.`,
            ),
          })
        }
        const detached = await this.#dependencies.detachAll(
          definition.name,
          mirrorPath,
          signalOptions(input.signal),
        )
        if (detached.failures.length > 0) {
          return this.view(definition, 'failed', false, {
            dependents: detached.failures.map((failure) => failure.repositoryPath),
            error: commandError(
              'dependent-detach-failed',
              detached.failures
                .map((failure) => `${failure.repositoryPath}: ${failure.message}`)
                .join(' '),
            ),
          })
        }
      }

      const scheduleRemoval = await this.#scheduler.remove(definition.name)
      if (scheduleRemoval.state !== 'off') {
        return this.view(definition, 'failed', false, {
          dependents: dependentPaths,
          error: commandError(
            'scheduler-remove-failed',
            scheduleRemoval.message ?? 'Could not remove native scheduler projection.',
          ),
        })
      }

      const releaseConfig = await this.#lock.acquireConfig()
      try {
        const configuration = await this.#store.load()
        const exists = configuration.repoMirrors.some((item) => item.name === definition.name)
        if (!exists) throw new UnknownRepoMirrorError([definition.name])
        await this.#store.save({
          ...configuration,
          repoMirrors: configuration.repoMirrors.filter((item) => item.name !== definition.name),
        })
      } finally {
        await releaseConfig()
      }

      if (await pathExists(mirrorPath)) {
        if (input.purge) await rm(mirrorPath, { force: true, recursive: true })
        else await moveToTrash(mirrorPath, definition.name, this.#paths)
      }
      return this.view(definition, 'removed', false, {
        dependents: input.force ? dependentPaths : [],
        forced: input.force,
        repositoryState: 'missing',
      })
    } finally {
      await releaseMirror()
    }
  }

  async doctorOne(
    definition: RepoMirrorDefinition,
    input: DoctorRepoMirrorsInput,
  ): Promise<RepoMirrorView> {
    const path = this.mirrorPath(definition.name)
    let health = await this.#gateway.inspect(definition, path)
    if (health.state !== 'ready' && input.fix) {
      const repaired = await this.repair(definition, input.signal)
      if (repaired !== null) {
        return this.view(definition, 'failed', true, {
          error: commandError('mirror-repair-failed', repaired),
        })
      }
      health = await this.#gateway.inspect(definition, path)
    }
    if (health.state !== 'ready') {
      return this.view(definition, 'failed', true, {
        error: commandError('mirror-invalid', health.issues.join(' ')),
      })
    }
    if (input.deep) {
      const checked = await this.#gateway.fsck(path, signalOptions(input.signal))
      if (checked.aborted || checked.exitCode !== 0) {
        return this.view(definition, 'failed', true, {
          error: commandError('mirror-fsck-failed', commandMessage(checked)),
        })
      }
    }
    if (input.remote) {
      const checked = await this.#gateway.probeRemote(
        definition.urls[0],
        signalOptions(input.signal),
      )
      if (checked.aborted || checked.exitCode !== 0) {
        return this.view(definition, 'failed', true, {
          error: commandError('mirror-remote-failed', commandMessage(checked)),
        })
      }
    }
    if (input.fix && definition.schedule !== undefined) {
      const schedule = await this.#scheduler.apply(definition)
      if (schedule.state !== 'ready') {
        return this.view(definition, 'failed', true, {
          error: commandError(
            'scheduler-repair-failed',
            schedule.message ?? 'Native scheduler is unavailable.',
          ),
        })
      }
    }
    return this.view(definition, input.fix ? 'repaired' : 'checked', true)
  }

  async repair(
    definition: RepoMirrorDefinition,
    signal: AbortSignal | undefined,
  ): Promise<string | null> {
    const releaseMirror = await this.#lock.acquireMirror(definition.name, { wait: false })
    if (releaseMirror === null) return 'Mirror is being used by another process.'
    const path = this.mirrorPath(definition.name)
    try {
      const dependents = await this.#dependencies.list(definition.name, path)
      if (dependents.length > 0) {
        return 'Repair is blocked while repositories borrow objects from this mirror.'
      }
      if ((await pathExists(path)) && !(await this.#gateway.isManagedMirror(path))) {
        return `Refusing to replace a path without the gits managed marker: ${path}`
      }
      await mkdir(this.#paths.temporary, { mode: 0o700, recursive: true })
      const temporaryRoot = await mkdtemp(join(this.#paths.temporary, `${definition.name}-repair-`))
      const temporaryMirror = resolve(temporaryRoot, `${definition.name}.git`)
      try {
        const cloned = await this.#gateway.cloneMirror(
          definition.urls[0],
          temporaryMirror,
          signalOptions(signal),
        )
        if (!cloned.ok) return operationMessage(cloned.commands)
        const health = await this.#gateway.inspect(definition, temporaryMirror)
        if (health.state !== 'ready') return health.issues.join(' ')
        if (await pathExists(path)) await moveToTrash(path, definition.name, this.#paths)
        await rename(temporaryMirror, path)
        return null
      } finally {
        await rm(temporaryRoot, { force: true, recursive: true })
      }
    } finally {
      await releaseMirror()
    }
  }

  async configurationIdentities(
    configuration: RepoMirrorConfiguration,
  ): Promise<ReadonlyMap<string, string>> {
    const identities = new Map<string, string>()
    for (const definition of configuration.repoMirrors) {
      for (const url of definition.urls) {
        const resolved = await resolveRepoMirrorUrl(this.#gateway, url)
        const owner = identities.get(resolved.key)
        if (owner !== undefined && owner !== definition.name) {
          throw new RepoMirrorUsageError(
            `Repository identity is assigned to both '${owner}' and '${definition.name}'.`,
          )
        }
        identities.set(resolved.key, definition.name)
      }
    }
    return identities
  }

  async view(
    definition: RepoMirrorDefinition,
    action: RepoMirrorAction,
    includeSize = false,
    overrides: ViewOverrides = {},
  ): Promise<RepoMirrorView> {
    const path = this.mirrorPath(definition.name)
    const [health, lastRun, dependents, sizeBytes, scheduler] = await Promise.all([
      this.#gateway.inspect(definition, path),
      this.#logger.readLastRun(definition.name),
      overrides.dependents === undefined
        ? this.#dependencies.list(definition.name, path)
        : Promise.resolve([]),
      includeSize ? directorySize(path) : Promise.resolve(null),
      this.#scheduler.inspect(definition),
    ])
    const next =
      definition.schedule === undefined ? null : nextScheduledDate(definition.schedule.cron)
    const invocation = this.#scheduler.invocation(definition.name)
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
    return resolve(this.#paths.mirrors, `${name}.git`)
  }
}

function formatInvocation(invocation: ReturnType<RepoMirrorScheduler['invocation']>): string {
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

function selectDefinitions(
  configuration: RepoMirrorConfiguration,
  names: readonly string[],
): readonly RepoMirrorDefinition[] {
  if (names.length === 0) return configuration.repoMirrors
  for (const name of names) validateRepoMirrorName(name)
  const wanted = new Set(names)
  const unknown = names.filter(
    (name, index) =>
      names.indexOf(name) === index &&
      !configuration.repoMirrors.some((item) => item.name === name),
  )
  if (unknown.length > 0) throw new UnknownRepoMirrorError(unknown)
  return configuration.repoMirrors.filter((definition) => wanted.has(definition.name))
}

function replaceDefinition(
  configuration: RepoMirrorConfiguration,
  replacement: RepoMirrorDefinition,
): RepoMirrorConfiguration {
  return {
    ...configuration,
    repoMirrors: configuration.repoMirrors.map((definition) =>
      definition.name === replacement.name ? replacement : definition,
    ),
  }
}

async function settledViews<T>(
  entries: readonly Readonly<{
    error?: unknown
    item: T
    status: 'fulfilled' | 'rejected' | 'not-run'
    value?: RepoMirrorView
  }>[],
  notRun: (item: T) => Promise<RepoMirrorView>,
): Promise<readonly RepoMirrorView[]> {
  return Promise.all(
    entries.map(async (entry) => {
      if (entry.status === 'fulfilled' && entry.value !== undefined) return entry.value
      if (entry.status === 'not-run') return notRun(entry.item)
      const message = entry.error instanceof Error ? entry.error.message : String(entry.error)
      const definition =
        typeof entry.item === 'object' && entry.item !== null && 'definition' in entry.item
          ? (entry.item.definition as RepoMirrorDefinition)
          : (entry.item as RepoMirrorDefinition)
      return {
        ...(await notRun(entry.item)),
        action: 'failed',
        error: commandError('repo-mirror-operation-failed', message),
        name: definition.name,
      }
    }),
  )
}

async function moveToTrash(path: string, name: string, paths: GitsPaths): Promise<string> {
  await mkdir(paths.trash, { mode: 0o700, recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '')
  const destination = resolve(paths.trash, `${timestamp}-${name}.git`)
  await rename(path, destination)
  return destination
}

function commandError(code: string, message: string): RepoMirrorCommandError {
  return { code, message }
}

function operationMessage(
  commands: readonly { readonly stderr: string; readonly stdout: string }[],
): string {
  const command = commands.at(-1)
  return command === undefined
    ? 'Git operation failed.'
    : command.stderr.trim() || command.stdout.trim() || 'Git operation failed.'
}

function commandMessage(command: { readonly stderr: string; readonly stdout: string }): string {
  return command.stderr.trim() || command.stdout.trim() || 'Git command failed.'
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))]
}

function asNonEmptyUrls(values: readonly string[]): readonly [string, ...string[]] {
  const first = values[0]
  if (first === undefined) throw new RepoMirrorUsageError('Mirror URL list cannot be empty.')
  return [first, ...values.slice(1)]
}

function signalOptions(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

function validateJobs(jobs: number | undefined): void {
  if (jobs !== undefined && (!Number.isInteger(jobs) || jobs < 1 || jobs > 32)) {
    throw new RepoMirrorUsageError('--jobs must be an integer from 1 to 32.')
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false
    throw error
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function suffixPrefixOverlap(previous: readonly string[], current: readonly string[]): number {
  const maximum = Math.min(previous.length, current.length)
  for (let size = maximum; size > 0; size -= 1) {
    const suffix = previous.slice(previous.length - size)
    const prefix = current.slice(0, size)
    if (suffix.every((line, index) => line === prefix[index])) return size
  }
  return 0
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolveDelay) => {
    const timeout = setTimeout(resolveDelay, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        resolveDelay()
      },
      { once: true },
    )
  })
}
