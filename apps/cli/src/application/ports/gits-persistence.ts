export interface GitsPersistenceTarget {
  readonly description: string
  readonly exists: boolean
  readonly id: string
  readonly kind: 'data-root' | 'directory' | 'file' | 'native-projection' | 'unregistered'
  readonly path: string
  readonly scope: 'external' | 'gits-home'
}

export interface GitsPersistencePurgeResult {
  readonly removedPaths: readonly string[]
  readonly warnings: readonly string[]
}

export interface GitsPersistence {
  inspect(): Promise<readonly GitsPersistenceTarget[]>
  purge(signal?: AbortSignal): Promise<GitsPersistencePurgeResult>
}
