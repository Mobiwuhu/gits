import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type {
  RepoMirrorDependent,
  RepoMirrorDetachResult,
} from '../types/index'

export interface IRepoMirrorDependencyService {
  detachAll(
    mirrorName: string,
    mirrorPath: string,
    options?: Readonly<{ signal?: AbortSignal }>
  ): Promise<RepoMirrorDetachResult>
  list(
    mirrorName: string,
    mirrorPath: string
  ): Promise<readonly RepoMirrorDependent[]>
  register(
    mirrorName: string,
    mirrorPath: string,
    repositoryPath: string,
    recordedRepositoryPath?: string
  ): Promise<boolean>
}

export const IRepoMirrorDependencyService: IdentifierDecorator<IRepoMirrorDependencyService> =
  createIdentifier<IRepoMirrorDependencyService>(
    'core.repoMirrorDependencyService'
  )
