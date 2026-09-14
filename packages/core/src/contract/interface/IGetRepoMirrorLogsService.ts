import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type { FollowRepoMirrorLogsInput, GetRepoMirrorLogsInput } from '../types/index'

export interface IGetRepoMirrorLogsService {
  execute(input: GetRepoMirrorLogsInput): Promise<readonly string[]>
  follow(input: FollowRepoMirrorLogsInput): AsyncGenerator<string, void>
}

export const IGetRepoMirrorLogsService: IdentifierDecorator<IGetRepoMirrorLogsService> =
  createIdentifier<IGetRepoMirrorLogsService>('core.getRepoMirrorLogsService')
