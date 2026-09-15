import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type {
  RepoMirrorCommandOutput,
  SetRepoMirrorsInput,
} from '../types/index'

export interface ISetRepoMirrorService {
  execute(input: SetRepoMirrorsInput): Promise<RepoMirrorCommandOutput>
}

export const ISetRepoMirrorService: IdentifierDecorator<ISetRepoMirrorService> =
  createIdentifier<ISetRepoMirrorService>('core.setRepoMirrorService')
