import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type { GitCommandOptions, GitCommandResult } from '../types/index'

export interface IGitCommandService {
  run(args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult>
}

export const IGitCommandService: IdentifierDecorator<IGitCommandService> =
  createIdentifier<IGitCommandService>('core.gitCommandService')
