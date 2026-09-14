import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type { ListRepoMirrorsInput, RepoMirrorCommandOutput } from '../types/index'

export interface IListRepoMirrorService {
  execute(input: ListRepoMirrorsInput): Promise<RepoMirrorCommandOutput>
}

export const IListRepoMirrorService: IdentifierDecorator<IListRepoMirrorService> =
  createIdentifier<IListRepoMirrorService>('core.listRepoMirrorService')
