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
  StatusTaskInput,
} from '../../../contract/index'
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
    const repositories = selectRepositories(configuration, input.repositories)
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
          !isConflictState(result.state) &&
          !result.flags.includes(RepositoryFlag.CheckoutDifferent)
      ),
      repos: results,
    }
  }
}
