import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type { GetRepoMirrorPathInput } from '../types/index'

export interface IGetRepoMirrorPathService {
  execute(input: GetRepoMirrorPathInput): Promise<string>
}

export const IGetRepoMirrorPathService: IdentifierDecorator<IGetRepoMirrorPathService> =
  createIdentifier<IGetRepoMirrorPathService>('core.getRepoMirrorPathService')
