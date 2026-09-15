import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type { RepoMirrorLockRelease } from '../types/index'

export interface IRepoMirrorLockService {
  acquireConfig(): Promise<RepoMirrorLockRelease>
  acquireFetchSlot(
    maximum: number,
    options?: Readonly<{ signal?: AbortSignal; wait?: boolean }>
  ): Promise<RepoMirrorLockRelease | null>
  acquireMirror(
    name: string,
    options?: Readonly<{ wait?: boolean }>
  ): Promise<RepoMirrorLockRelease | null>
}

export const IRepoMirrorLockService: IdentifierDecorator<IRepoMirrorLockService> =
  createIdentifier<IRepoMirrorLockService>('core.repoMirrorLockService')
