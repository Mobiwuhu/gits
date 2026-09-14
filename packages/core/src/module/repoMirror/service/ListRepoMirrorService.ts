import { Inject } from '@wendellhu/redi'

import {
  type IListRepoMirrorService,
  IRepoMirrorConfigurationService,
  IRepoMirrorStoreService,
  IRepoMirrorViewService,
  RepoMirrorAction,
  type ListRepoMirrorsInput,
  type RepoMirrorCommandOutput,
} from '../../../contract/index'

export class ListRepoMirrorService implements IListRepoMirrorService {
  constructor(
    @Inject(IRepoMirrorConfigurationService)
    private readonly configuration: IRepoMirrorConfigurationService,
    @Inject(IRepoMirrorStoreService) private readonly store: IRepoMirrorStoreService,
    @Inject(IRepoMirrorViewService) private readonly view: IRepoMirrorViewService,
  ) {}

  async execute(input: ListRepoMirrorsInput): Promise<RepoMirrorCommandOutput> {
    const configuration = await this.store.load()
    const definitions = this.configuration.select(configuration, input.names)
    const mirrors = await Promise.all(
      definitions.map((definition) =>
        this.view.create(definition, RepoMirrorAction.Checked, input.includeSize === true),
      ),
    )
    return { command: 'repo-mirrors list', mirrors, ok: true }
  }
}
