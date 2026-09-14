import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type {
  RepoMirrorAction,
  RepoMirrorDefinition,
  RepoMirrorView,
  RepoMirrorViewOverrides,
} from '../types/index'

export interface IRepoMirrorViewService {
  create(
    definition: RepoMirrorDefinition,
    action: RepoMirrorAction,
    includeSize?: boolean,
    overrides?: RepoMirrorViewOverrides,
  ): Promise<RepoMirrorView>
  mirrorPath(name: string): string
}

export const IRepoMirrorViewService: IdentifierDecorator<IRepoMirrorViewService> =
  createIdentifier<IRepoMirrorViewService>('core.repoMirrorViewService')
