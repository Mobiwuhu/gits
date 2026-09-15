import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type {
  RepoMirrorDefinition,
  RepoMirrorScheduledInvocation,
  RepoMirrorSchedulerObservation,
} from '../types/index'

export interface IRepoMirrorSchedulerService {
  apply(
    definition: RepoMirrorDefinition
  ): Promise<RepoMirrorSchedulerObservation>
  inspect(
    definition: RepoMirrorDefinition
  ): Promise<RepoMirrorSchedulerObservation>
  invocation(name: string): RepoMirrorScheduledInvocation
  remove(name: string): Promise<RepoMirrorSchedulerObservation>
}

export const IRepoMirrorSchedulerService: IdentifierDecorator<IRepoMirrorSchedulerService> =
  createIdentifier<IRepoMirrorSchedulerService>(
    'core.repoMirrorSchedulerService'
  )
