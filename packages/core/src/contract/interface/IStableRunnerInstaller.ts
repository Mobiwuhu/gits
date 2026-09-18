import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type {
  RepoMirrorScheduledInvocation,
  StableRunnerObservation,
} from '../types/index'

export interface IStableRunnerInstaller {
  inspect(): Promise<StableRunnerObservation>
  install(): Promise<string>
  invocation(name: string): RepoMirrorScheduledInvocation
  path(): string
  refreshIfInstalled(): Promise<boolean>
}

export const IStableRunnerInstaller: IdentifierDecorator<IStableRunnerInstaller> =
  createIdentifier<IStableRunnerInstaller>('core.stableRunnerInstaller')
