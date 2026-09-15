import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type { RepoMirrorConfiguration } from '../types/index'

export interface IRepoMirrorStoreService {
  load(): Promise<RepoMirrorConfiguration>
  save(configuration: RepoMirrorConfiguration): Promise<void>
}

export const IRepoMirrorStoreService: IdentifierDecorator<IRepoMirrorStoreService> =
  createIdentifier<IRepoMirrorStoreService>('core.repoMirrorStoreService')
