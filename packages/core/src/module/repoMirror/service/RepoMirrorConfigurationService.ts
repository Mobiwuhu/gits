import { Inject } from '@wendellhu/redi'

import {
  IRepoMirrorGitService,
  RepoMirrorUsageError,
  UnknownRepoMirrorError,
} from '../../../contract/index'
import type {
  IRepoMirrorConfigurationService,
  RepoMirrorConfiguration,
  RepoMirrorDefinition,
} from '../../../contract/index'
import {
  resolveRepoMirrorUrl,
  validateRepoMirrorName,
} from './repoMirrorIdentity'

export class RepoMirrorConfigurationService implements IRepoMirrorConfigurationService {
  constructor(
    @Inject(IRepoMirrorGitService) private readonly git: IRepoMirrorGitService
  ) {}

  select(
    configuration: RepoMirrorConfiguration,
    names: readonly string[]
  ): readonly RepoMirrorDefinition[] {
    if (names.length === 0) {
      return configuration.repoMirrors
    }
    for (const name of names) {
      validateRepoMirrorName(name)
    }
    const wanted = new Set(names)
    const unknown = names.filter(
      (name, index) =>
        names.indexOf(name) === index &&
        !configuration.repoMirrors.some((item) => item.name === name)
    )
    if (unknown.length > 0) {
      throw new UnknownRepoMirrorError(unknown)
    }
    return configuration.repoMirrors.filter((definition) =>
      wanted.has(definition.name)
    )
  }

  async identities(
    configuration: RepoMirrorConfiguration
  ): Promise<ReadonlyMap<string, string>> {
    const identities = new Map<string, string>()
    for (const definition of configuration.repoMirrors) {
      for (const url of definition.urls) {
        // 配置文件按固定顺序读取，确保诊断结果稳定。
        // eslint-disable-next-line no-await-in-loop
        const resolved = await resolveRepoMirrorUrl(this.git, url)
        const owner = identities.get(resolved.key)
        if (owner !== undefined && owner !== definition.name) {
          throw new RepoMirrorUsageError(
            `Repository identity is assigned to both '${owner}' and '${definition.name}'.`
          )
        }
        identities.set(resolved.key, definition.name)
      }
    }
    return identities
  }

  replace(
    configuration: RepoMirrorConfiguration,
    replacement: RepoMirrorDefinition
  ): RepoMirrorConfiguration {
    return {
      ...configuration,
      repoMirrors: configuration.repoMirrors.map((definition) =>
        definition.name === replacement.name ? replacement : definition
      ),
    }
  }
}
