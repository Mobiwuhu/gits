import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type { RepoMirrorScheduledInvocation } from '../types/index'

export interface IStableRunnerInstaller {
  install(): Promise<string>
  invocation(name: string): RepoMirrorScheduledInvocation
  path(): string
}

export const IStableRunnerInstaller: IdentifierDecorator<IStableRunnerInstaller> =
  createIdentifier<IStableRunnerInstaller>('core.stableRunnerInstaller')
