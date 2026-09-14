import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type { AddRepoMirrorsInput, RepoMirrorCommandOutput } from '../types/index'

export interface IAddRepoMirrorService {
  execute(input: AddRepoMirrorsInput): Promise<RepoMirrorCommandOutput>
}

export const IAddRepoMirrorService: IdentifierDecorator<IAddRepoMirrorService> =
  createIdentifier<IAddRepoMirrorService>('core.addRepoMirrorService')
