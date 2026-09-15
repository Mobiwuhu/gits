import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type {
  RepoMirrorConfiguration,
  RepoMirrorDefinition,
} from '../types/index'

export interface IRepoMirrorConfigurationService {
  identities(
    configuration: RepoMirrorConfiguration
  ): Promise<ReadonlyMap<string, string>>
  replace(
    configuration: RepoMirrorConfiguration,
    replacement: RepoMirrorDefinition
  ): RepoMirrorConfiguration
  select(
    configuration: RepoMirrorConfiguration,
    names: readonly string[]
  ): readonly RepoMirrorDefinition[]
}

export const IRepoMirrorConfigurationService: IdentifierDecorator<IRepoMirrorConfigurationService> =
  createIdentifier<IRepoMirrorConfigurationService>(
    'core.repoMirrorConfigurationService'
  )
