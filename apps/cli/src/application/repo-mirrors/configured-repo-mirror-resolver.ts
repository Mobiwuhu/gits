import { resolve } from 'node:path'

import type { RepoMirrorLock } from '../ports/repo-mirror-lock.js'
import type { RepoMirrorGateway } from '../ports/repo-mirror-gateway.js'
import type {
  RepoMirrorLease,
  RepoMirrorResolution,
  RepoMirrorResolver,
} from '../ports/repo-mirror-resolver.js'
import type { RepoMirrorStore } from '../ports/repo-mirror-store.js'
import { resolveRepoMirrorUrl } from './repo-mirror-identity.js'
import type { GitsPaths } from '../../infrastructure/repo-mirrors/gits-paths.js'

export class ConfiguredRepoMirrorResolver implements RepoMirrorResolver {
  readonly #gateway: RepoMirrorGateway
  readonly #lock: RepoMirrorLock
  readonly #paths: GitsPaths
  readonly #store: RepoMirrorStore

  constructor(
    store: RepoMirrorStore,
    gateway: RepoMirrorGateway,
    lock: RepoMirrorLock,
    paths: GitsPaths,
  ) {
    this.#store = store
    this.#gateway = gateway
    this.#lock = lock
    this.#paths = paths
  }

  async resolve(url: string): Promise<RepoMirrorResolution> {
    try {
      const target = await resolveRepoMirrorUrl(this.#gateway, url)
      const configuration = await this.#store.load()
      const matches: { name: string; path: string }[] = []
      for (const definition of configuration.repoMirrors) {
        for (const configuredUrl of definition.urls) {
          const candidate = await resolveRepoMirrorUrl(this.#gateway, configuredUrl)
          if (candidate.key === target.key) {
            matches.push({
              name: definition.name,
              path: resolve(this.#paths.mirrors, `${definition.name}.git`),
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
      const release = await this.#lock.acquireMirror(match.name, { wait: false })
      if (release === null) {
        return {
          fallbackReason: `Repo mirror '${match.name}' is busy.`,
          lease: null,
        }
      }
      try {
        const health = await this.#gateway.inspect(definition, match.path)
        if (health.state !== 'ready') {
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
