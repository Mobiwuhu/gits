import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type { RepoMirrorResolution } from '../types/index'

export interface IResolveRepoMirrorService {
  resolve(url: string): Promise<RepoMirrorResolution>
}

export const IResolveRepoMirrorService: IdentifierDecorator<IResolveRepoMirrorService> =
  createIdentifier<IResolveRepoMirrorService>('core.resolveRepoMirrorService')
