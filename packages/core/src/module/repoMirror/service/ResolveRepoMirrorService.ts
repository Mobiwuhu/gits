import { resolve } from 'node:path'

import { Inject } from '@wendellhu/redi'

import {
  IGitsPathService,
  IRepoMirrorGitService,
  IRepoMirrorLockService,
  IRepoMirrorStoreService,
  RepoMirrorRepositoryState,
  type IResolveRepoMirrorService,
  type RepoMirrorLease,
  type RepoMirrorResolution,
} from '../../../contract/index'
import { resolveRepoMirrorUrl } from './repoMirrorIdentity'

export class ResolveRepoMirrorService implements IResolveRepoMirrorService {
  constructor(
    @Inject(IRepoMirrorStoreService) private readonly store: IRepoMirrorStoreService,
    @Inject(IRepoMirrorGitService) private readonly git: IRepoMirrorGitService,
    @Inject(IRepoMirrorLockService) private readonly lock: IRepoMirrorLockService,
    @Inject(IGitsPathService) private readonly paths: IGitsPathService,
  ) {}

  async resolve(url: string): Promise<RepoMirrorResolution> {
    try {
      const target = await resolveRepoMirrorUrl(this.git, url)
      const configuration = await this.store.load()
      const matches: { name: string; path: string }[] = []
      for (const definition of configuration.repoMirrors) {
        for (const configuredUrl of definition.urls) {
          const candidate = await resolveRepoMirrorUrl(this.git, configuredUrl)
          if (candidate.key === target.key) {
            matches.push({
              name: definition.name,
              path: resolve(this.paths.mirrors, `${definition.name}.git`),
            })
            break
          }
        }
      }
      if (matches.length === 0) return { lease: null }
      if (matches.length > 1) {
        return {
          fallbackReason: 'Multiple repo mirrors match this remote; run repo-mirrors doctor.',
          lease: null,
        }
      }
      const match = matches[0]
      if (match === undefined) return { lease: null }
      const definition = configuration.repoMirrors.find((item) => item.name === match.name)
      if (definition === undefined) return { lease: null }
      const release = await this.lock.acquireMirror(match.name, { wait: false })
      if (release === null) {
        return {
          fallbackReason: `Repo mirror '${match.name}' is busy.`,
          lease: null,
        }
      }
      try {
        const health = await this.git.inspect(definition, match.path)
        if (health.state !== RepoMirrorRepositoryState.Ready) {
          await release()
          return {
            fallbackReason: `Repo mirror '${match.name}' is ${health.state}.`,
            lease: null,
          }
        }
        const lease: RepoMirrorLease = {
          name: match.name,
          path: match.path,
          release,
        }
        return { lease }
      } catch (error) {
        await release()
        throw error
      }
    } catch (error) {
      return {
        fallbackReason: error instanceof Error ? error.message : String(error),
        lease: null,
      }
    }
  }
}
