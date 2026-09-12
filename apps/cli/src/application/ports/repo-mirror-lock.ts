export type RepoMirrorLockRelease = () => Promise<void>

export interface RepoMirrorLock {
  acquireConfig(): Promise<RepoMirrorLockRelease>
  acquireFetchSlot(
    maximum: number,
    options?: Readonly<{ signal?: AbortSignal; wait?: boolean }>,
  ): Promise<RepoMirrorLockRelease | null>
  acquireMirror(
    name: string,
    options?: Readonly<{ wait?: boolean }>,
  ): Promise<RepoMirrorLockRelease | null>
}
