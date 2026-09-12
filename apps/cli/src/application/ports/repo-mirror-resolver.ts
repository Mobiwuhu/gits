export interface RepoMirrorLease {
  readonly name: string
  readonly path: string
  release(): Promise<void>
}

export interface RepoMirrorResolution {
  readonly fallbackReason?: string
  readonly lease: RepoMirrorLease | null
}

export interface RepoMirrorResolver {
  resolve(url: string): Promise<RepoMirrorResolution>
}
