import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

import { Inject } from '@wendellhu/redi'

import {
  IGitService,
  ITaskConfigurationService,
  RepositoryActionResult,
  RepositoryFlag,
} from '../../../contract/index'
import type {
  IStatusTaskService,
  CommandOutput,
  RepositoryLocation,
  StatusTaskInput,
} from '../../../contract/index'
import { hasErrorCode } from '../../../util/index'
import { loadTaskConfiguration } from './loadTaskConfiguration'
import { isConflictState, withActionResult } from './taskResult'
import { selectRepositories } from './taskSelection'

export class StatusTaskService implements IStatusTaskService {
  constructor(
    @Inject(ITaskConfigurationService)
    private readonly configurationStore: ITaskConfigurationService,
    @Inject(IGitService) private readonly git: IGitService
  ) {}

  async execute(input: StatusTaskInput): Promise<CommandOutput> {
    const configuration = await loadTaskConfiguration(
      this.configurationStore,
      this.git,
      {
        root: input.root,
        ...(input.signal ? { signal: input.signal } : {}),
      }
    )
    const configured = selectRepositories(configuration, input.repositories)
    const discovered =
      input.repositories.length === 0
        ? await discoverRepositories(
            input.root,
            configuration.repositories,
            input.signal
          )
        : []
    const repositories: readonly RepositoryLocation[] = [
      ...configured,
      ...discovered,
    ]
    const results = await Promise.all(
      repositories.map(async (repository) =>
        withActionResult(
          await this.git.inspect(
            repository,
            input.signal ? { signal: input.signal } : {}
          ),
          RepositoryActionResult.Skipped
        )
      )
    )

    return {
      command: 'status',
      ok: results.every(
        (result) =>
          result.result !== RepositoryActionResult.Failed &&
          (result.expected === null ||
            (!isConflictState(result.state) &&
              !result.flags.includes(RepositoryFlag.CheckoutDifferent)))
      ),
      repos: results,
    }
  }
}

async function discoverRepositories(
  root: string,
  configured: readonly RepositoryLocation[],
  signal?: AbortSignal
): Promise<readonly RepositoryLocation[]> {
  const repositoriesRoot = resolve(root, 'repos')
  const configuredPaths = new Set(
    configured.map((repository) => resolve(repository.absolutePath))
  )
  return visit(repositoriesRoot)

  async function visit(
    directory: string
  ): Promise<readonly RepositoryLocation[]> {
    signal?.throwIfAborted()

    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error: unknown) {
      if (hasErrorCode(error, 'ENOENT')) {
        return []
      }
      throw error
    }

    const isGitRepository = entries.some(
      (entry) =>
        entry.name === '.git' && (entry.isDirectory() || entry.isFile())
    )
    if (isGitRepository) {
      const absolutePath = resolve(directory)
      if (
        absolutePath !== repositoriesRoot &&
        !configuredPaths.has(absolutePath)
      ) {
        const name = toPosixPath(relative(repositoriesRoot, absolutePath))
        return [
          {
            absolutePath,
            name,
            path: toPosixPath(relative(root, absolutePath)),
          },
        ]
      }
      return []
    }

    const childDirectories = entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name !== '.git' &&
          !entry.name.startsWith('.gits-install-')
      )
      .map((entry) => entry.name)
      .toSorted()
    const nestedRepositories = await Promise.all(
      childDirectories.map((child) => visit(resolve(directory, child)))
    )
    return nestedRepositories.flat()
  }
}

function toPosixPath(path: string): string {
  return path.split(sep).join('/')
}
