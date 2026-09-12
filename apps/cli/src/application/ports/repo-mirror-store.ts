import type { RepoMirrorConfiguration } from '../../domain/repo-mirror/model.js'

export interface RepoMirrorStore {
  load(): Promise<RepoMirrorConfiguration>
  save(configuration: RepoMirrorConfiguration): Promise<void>
}
