import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type {
  GitBranchPreparation,
  GitBranchPreparationOptions,
  GitCheckoutPathValidation,
  GitCloneOptions,
  GitCommandResult,
  GitOperationOptions,
  GitPushOptions,
  GitReferenceLookup,
  GitStashResult,
  RepositoryCommandResult,
  TaskRepository,
} from '../types/index'

export interface IGitService {
  applyCheckout(
    path: string,
    checkout: readonly string[] | null,
    options?: GitOperationOptions
  ): Promise<GitCommandResult>
  checkRefFormat(
    branch: string,
    options?: GitOperationOptions
  ): Promise<GitCommandResult>
  clone(
    url: string,
    destination: string,
    options?: GitCloneOptions
  ): Promise<GitCommandResult>
  fetch(path: string, options?: GitOperationOptions): Promise<GitCommandResult>
  getRemoteUrl(
    path: string,
    remote?: string,
    options?: GitOperationOptions
  ): Promise<string | null>
  hasRef(
    path: string,
    fullRef: string,
    options?: GitOperationOptions
  ): Promise<GitReferenceLookup>
  inspect(
    repository: TaskRepository,
    options?: GitOperationOptions
  ): Promise<RepositoryCommandResult>
  prepareBranch(
    path: string,
    branch: GitBranchPreparationOptions,
    options?: GitOperationOptions
  ): Promise<GitBranchPreparation>
  probeRemote(
    url: string,
    options?: GitOperationOptions
  ): Promise<GitCommandResult>
  push(
    path: string,
    branch: string,
    options?: GitPushOptions
  ): Promise<GitCommandResult>
  stash(
    path: string,
    message: string,
    options?: GitOperationOptions
  ): Promise<GitStashResult>
  switchToBranch(
    path: string,
    branch: Omit<GitBranchPreparationOptions, 'fetchIfMissing'>,
    options?: GitOperationOptions
  ): Promise<GitBranchPreparation>
  validateCheckoutPaths(
    path: string,
    checkout: readonly string[],
    options?: GitOperationOptions
  ): Promise<GitCheckoutPathValidation>
}

export const IGitService: IdentifierDecorator<IGitService> =
  createIdentifier<IGitService>('core.gitService')
