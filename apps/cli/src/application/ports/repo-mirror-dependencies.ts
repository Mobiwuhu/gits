import type { RepoMirrorDependent } from '../../domain/repo-mirror/model.js'

export interface RepoMirrorDetachFailure {
  readonly message: string
  readonly repositoryPath: string
}

export interface RepoMirrorDetachResult {
  readonly detached: readonly string[]
  readonly failures: readonly RepoMirrorDetachFailure[]
}

export interface RepoMirrorDependencies {
  detachAll(
    mirrorName: string,
    mirrorPath: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<RepoMirrorDetachResult>
  list(mirrorName: string, mirrorPath: string): Promise<readonly RepoMirrorDependent[]>
  register(
    mirrorName: string,
    mirrorPath: string,
    repositoryPath: string,
    recordedRepositoryPath?: string,
  ): Promise<boolean>
}
