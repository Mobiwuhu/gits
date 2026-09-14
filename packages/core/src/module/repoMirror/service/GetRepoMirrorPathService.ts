import { Inject } from '@wendellhu/redi'

import {
  type IGetRepoMirrorPathService,
  IRepoMirrorConfigurationService,
  IRepoMirrorStoreService,
  IRepoMirrorViewService,
  type GetRepoMirrorPathInput,
} from '../../../contract/index'
import { validateRepoMirrorName } from './repoMirrorIdentity'

export class GetRepoMirrorPathService implements IGetRepoMirrorPathService {
  constructor(
    @Inject(IRepoMirrorConfigurationService)
    private readonly configuration: IRepoMirrorConfigurationService,
    @Inject(IRepoMirrorStoreService) private readonly store: IRepoMirrorStoreService,
    @Inject(IRepoMirrorViewService) private readonly view: IRepoMirrorViewService,
  ) {}

  async execute(input: GetRepoMirrorPathInput): Promise<string> {
    validateRepoMirrorName(input.name)
    const configuration = await this.store.load()
    this.configuration.select(configuration, [input.name])
    return this.view.mirrorPath(input.name)
  }
}
