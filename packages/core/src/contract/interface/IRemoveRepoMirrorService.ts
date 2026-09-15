import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type {
  RemoveRepoMirrorsInput,
  RepoMirrorCommandOutput,
} from '../types/index'

export interface IRemoveRepoMirrorService {
  execute(input: RemoveRepoMirrorsInput): Promise<RepoMirrorCommandOutput>
}

export const IRemoveRepoMirrorService: IdentifierDecorator<IRemoveRepoMirrorService> =
  createIdentifier<IRemoveRepoMirrorService>('core.removeRepoMirrorService')
