import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type { FetchRepoMirrorsInput, RepoMirrorCommandOutput } from '../types/index'

export interface IFetchRepoMirrorService {
  execute(input: FetchRepoMirrorsInput): Promise<RepoMirrorCommandOutput>
}

export const IFetchRepoMirrorService: IdentifierDecorator<IFetchRepoMirrorService> =
  createIdentifier<IFetchRepoMirrorService>('core.fetchRepoMirrorService')
