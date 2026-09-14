import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type { GitsPersistencePurgeResult, GitsPersistenceTarget } from '../types/index'

export interface IGitsPersistenceService {
  inspect(): Promise<readonly GitsPersistenceTarget[]>
  purge(signal?: AbortSignal): Promise<GitsPersistencePurgeResult>
}

export const IGitsPersistenceService: IdentifierDecorator<IGitsPersistenceService> =
  createIdentifier<IGitsPersistenceService>('core.gitsPersistenceService')
