import { Inject } from '@wendellhu/redi'

import {
  IAddRepoMirrorService,
  type IAddTaskRepoMirrorsService,
  ITaskConfigurationService,
  type AddTaskRepoMirrorsInput,
  type AddTaskRepoMirrorsOutput,
} from '../../../contract/index'
import { selectRepositories } from './taskSelection'

export class AddTaskRepoMirrorsService implements IAddTaskRepoMirrorsService {
  constructor(
    @Inject(IAddRepoMirrorService) private readonly addRepoMirror: IAddRepoMirrorService,
    @Inject(ITaskConfigurationService) private readonly configuration: ITaskConfigurationService,
  ) {}

  async execute(input: AddTaskRepoMirrorsInput): Promise<AddTaskRepoMirrorsOutput> {
    const loaded = await this.configuration.load(input.root)
    const urls = selectRepositories(loaded.configuration, input.repositories).map(
      (repository) => repository.url,
    )
    return this.addRepoMirror.execute({
      aliases: [],
      dryRun: input.dryRun,
      urls,
      ...(input.jobs === undefined ? {} : { jobs: input.jobs }),
      ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  }
}
