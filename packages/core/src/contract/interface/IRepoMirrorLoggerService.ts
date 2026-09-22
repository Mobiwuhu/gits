import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type { RepoMirrorInvocationSource } from '../constants/index'
import type { RepoMirrorLogSession, RepoMirrorRunState } from '../types/index'

export interface IRepoMirrorLoggerService {
  readLastRun(name: string): Promise<RepoMirrorRunState | null>
  readLines(name: string, maximum: number): Promise<readonly string[]>
  start(
    name: string,
    source: RepoMirrorInvocationSource
  ): Promise<RepoMirrorLogSession>
}

export const IRepoMirrorLoggerService: IdentifierDecorator<IRepoMirrorLoggerService> =
  createIdentifier<IRepoMirrorLoggerService>('core.repoMirrorLoggerService')
