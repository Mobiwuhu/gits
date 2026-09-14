import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type {
  GitCommandResult,
  GitOperationOptions,
  RepoMirrorDefinition,
  RepoMirrorGitOperation,
  RepoMirrorHealth,
} from '../types/index'

export interface IRepoMirrorGitService {
  cloneMirror(
    url: string,
    destination: string,
    options?: GitOperationOptions,
  ): Promise<RepoMirrorGitOperation>
  fetchMirror(path: string, options?: GitOperationOptions): Promise<RepoMirrorGitOperation>
  fsck(path: string, options?: GitOperationOptions): Promise<GitCommandResult>
  inspect(definition: RepoMirrorDefinition, path: string): Promise<RepoMirrorHealth>
  isManagedMirror(path: string): Promise<boolean>
  maintainMirror(path: string, options?: GitOperationOptions): Promise<GitCommandResult>
  probeRemote(url: string, options?: GitOperationOptions): Promise<GitCommandResult>
  repackDependent(path: string, options?: GitOperationOptions): Promise<GitCommandResult>
  resolveGitDirectory(path: string, options?: GitOperationOptions): Promise<string | null>
  resolveRemoteUrl(url: string, options?: GitOperationOptions): Promise<string | null>
  setFetchUrl(
    path: string,
    url: string,
    options?: GitOperationOptions,
  ): Promise<RepoMirrorGitOperation>
}

export const IRepoMirrorGitService: IdentifierDecorator<IRepoMirrorGitService> =
  createIdentifier<IRepoMirrorGitService>('core.repoMirrorGitService')
