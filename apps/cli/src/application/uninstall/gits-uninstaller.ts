import type { GitsPersistence, GitsPersistenceTarget } from '../ports/gits-persistence.js'
import type { RepoMirrorDependencies } from '../ports/repo-mirror-dependencies.js'
import type { RepoMirrorStore } from '../ports/repo-mirror-store.js'
import type { RepoMirrorManager } from '../repo-mirrors/repo-mirror-manager.js'
import { RepoMirrorUsageError } from '../../domain/repo-mirror/errors.js'
import type { RepoMirrorDefinition } from '../../domain/repo-mirror/model.js'

export interface GitsUninstallMirror {
  readonly dependents: readonly string[]
  readonly name: string
  readonly path: string
}

export interface GitsUninstallPlan {
  readonly mirrors: readonly GitsUninstallMirror[]
  readonly targets: readonly GitsPersistenceTarget[]
  readonly warnings: readonly string[]
}

export interface GitsUninstallOutput extends GitsUninstallPlan {
  readonly command: 'uninstall'
  readonly dryRun: boolean
  readonly ok: boolean
  readonly removedMirrors: readonly string[]
  readonly removedPaths: readonly string[]
}

export interface UninstallGitsInput {
  readonly confirmed: boolean
  readonly detachDependents: boolean
  readonly dryRun: boolean
  readonly force: boolean
  readonly signal?: AbortSignal
}

export interface GitsUninstallerDependencies {
  readonly dependencies: RepoMirrorDependencies
  readonly persistence: GitsPersistence
  readonly repoMirrors: RepoMirrorManager
  readonly store: RepoMirrorStore
}

export class GitsUninstaller {
  readonly #dependencies: RepoMirrorDependencies
  readonly #persistence: GitsPersistence
  readonly #repoMirrors: RepoMirrorManager
  readonly #store: RepoMirrorStore

  constructor(dependencies: GitsUninstallerDependencies) {
    this.#dependencies = dependencies.dependencies
    this.#persistence = dependencies.persistence
    this.#repoMirrors = dependencies.repoMirrors
    this.#store = dependencies.store
  }

  async plan(force = false): Promise<GitsUninstallPlan> {
    let definitions: readonly RepoMirrorDefinition[]
    const warnings: string[] = []
    try {
      definitions = (await this.#store.load()).repoMirrors
    } catch (error) {
      if (!force) throw error
      definitions = []
      warnings.push(
        `Mirror configuration could not be read; --force will remove owned storage without dependent checks: ${errorMessage(error)}`,
      )
    }

    const inspected = await Promise.all(
      definitions.map(
        async (
          definition,
        ): Promise<{
          mirror: GitsUninstallMirror
          warning: string | null
        }> => {
          const path = this.#repoMirrors.mirrorPath(definition.name)
          try {
            const dependents = await this.#dependencies.list(definition.name, path)
            return {
              mirror: {
                dependents: dependents.map((dependent) => dependent.repositoryPath),
                name: definition.name,
                path,
              },
              warning: null,
            }
          } catch (error) {
            if (!force) throw error
            return {
              mirror: { dependents: [], name: definition.name, path },
              warning: `Dependencies for '${definition.name}' could not be read; --force will remove owned storage without checking them: ${errorMessage(error)}`,
            }
          }
        },
      ),
    )
    warnings.push(...inspected.flatMap(({ warning }) => (warning === null ? [] : [warning])))
    return {
      mirrors: inspected.map(({ mirror }) => mirror),
      targets: await this.#persistence.inspect(),
      warnings,
    }
  }

  async uninstall(input: UninstallGitsInput): Promise<GitsUninstallOutput> {
    if (input.detachDependents && input.force) {
      throw new RepoMirrorUsageError('--force and --detach-dependents cannot be combined.')
    }
    if (!input.dryRun && !input.confirmed) {
      throw new RepoMirrorUsageError('Uninstall requires confirmation or --yes.')
    }

    const plan = await this.plan(input.force)
    const liveDependents = plan.mirrors.flatMap((mirror) => mirror.dependents)
    const dependencyWarning =
      liveDependents.length > 0 && !input.detachDependents && !input.force
        ? `Uninstall is blocked because ${liveDependents.length} installed repositor${
            liveDependents.length === 1 ? 'y borrows' : 'ies borrow'
          } mirror objects. Use --detach-dependents for a safe uninstall or --force to bypass protection.`
        : null
    const forceWarning = input.force
      ? '--force bypasses mirror health and dependency protection; listed dependent repositories may become unusable.'
      : null
    if (input.dryRun || dependencyWarning !== null) {
      return {
        command: 'uninstall',
        dryRun: input.dryRun,
        mirrors: plan.mirrors,
        ok: input.dryRun || dependencyWarning === null,
        removedMirrors: [],
        removedPaths: [],
        targets: plan.targets,
        warnings: [
          ...plan.warnings,
          ...(dependencyWarning === null ? [] : [dependencyWarning]),
          ...(forceWarning === null ? [] : [forceWarning]),
        ],
      }
    }

    input.signal?.throwIfAborted()
    const names = plan.mirrors.map((mirror) => mirror.name)
    if (input.force) {
      const purged = await this.#persistence.purge(input.signal)
      return {
        command: 'uninstall',
        dryRun: false,
        mirrors: plan.mirrors,
        ok: true,
        removedMirrors: names,
        removedPaths: purged.removedPaths,
        targets: plan.targets,
        warnings: [
          ...plan.warnings,
          ...(forceWarning === null ? [] : [forceWarning]),
          ...purged.warnings,
        ],
      }
    }

    let removedMirrors: readonly string[] = []
    if (names.length > 0) {
      const result = await this.#repoMirrors.remove({
        confirmed: true,
        detachDependents: input.detachDependents,
        force: input.force,
        names,
        purge: true,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      removedMirrors = result.mirrors
        .filter((mirror) => mirror.action === 'removed')
        .map((mirror) => mirror.name)
      if (!result.ok) {
        const failures = result.mirrors
          .filter((mirror) => mirror.error !== null)
          .map((mirror) => `${mirror.name}: ${mirror.error?.message ?? 'removal failed'}`)
        return {
          command: 'uninstall',
          dryRun: false,
          mirrors: plan.mirrors,
          ok: false,
          removedMirrors,
          removedPaths: [],
          targets: plan.targets,
          warnings: [...plan.warnings, ...failures, 'GITS_HOME was retained for recovery.'],
        }
      }
    }

    const purged = await this.#persistence.purge(input.signal)
    return {
      command: 'uninstall',
      dryRun: false,
      mirrors: plan.mirrors,
      ok: true,
      removedMirrors,
      removedPaths: purged.removedPaths,
      targets: plan.targets,
      warnings: [...plan.warnings, ...purged.warnings],
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
