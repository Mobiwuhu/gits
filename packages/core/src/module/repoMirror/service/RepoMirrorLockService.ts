import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'

import lockfile from '@bybrave/proper-lockfile2'
import { Inject } from '@wendellhu/redi'

import { IGitsPathService } from '../../../contract/index'
import type {
  IRepoMirrorLockService,
  RepoMirrorLockRelease,
} from '../../../contract/index'
import { hasErrorCode } from '../../../util/index'

const staleMilliseconds = 60_000
const updateMilliseconds = 10_000

export class RepoMirrorLockService implements IRepoMirrorLockService {
  constructor(
    @Inject(IGitsPathService) private readonly paths: IGitsPathService
  ) {}

  async acquireConfig(): Promise<RepoMirrorLockRelease> {
    const target = resolvePath(this.paths.locks, 'config')
    await ensureTarget(target)
    return lockfile.lock(target, {
      retries: { factor: 1.4, maxTimeout: 250, minTimeout: 25, retries: 20 },
      stale: staleMilliseconds,
      update: updateMilliseconds,
    })
  }

  async acquireMirror(
    name: string,
    options: Readonly<{ wait?: boolean }> = {}
  ): Promise<RepoMirrorLockRelease | null> {
    const target = resolvePath(this.paths.locks, 'repo-mirrors', name)
    await ensureTarget(target)
    return tryLock(target, options.wait === true ? 20 : 0)
  }

  async acquireFetchSlot(
    maximum: number,
    options: Readonly<{ signal?: AbortSignal; wait?: boolean }> = {}
  ): Promise<RepoMirrorLockRelease | null> {
    const attempts = options.wait === false ? 1 : 101
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (options.signal?.aborted === true) {
        return null
      }
      for (let slot = 0; slot < maximum; slot += 1) {
        const target = resolvePath(
          this.paths.locks,
          'fetch-slots',
          String(slot)
        )
        await ensureTarget(target)
        const release = await tryLock(target, 0)
        if (release !== null) {
          return release
        }
      }
      if (attempt + 1 < attempts) {
        await abortableDelay(100, options.signal)
      }
    }
    return null
  }
}

async function tryLock(
  target: string,
  retries: number
): Promise<RepoMirrorLockRelease | null> {
  try {
    return await lockfile.lock(target, {
      retries,
      stale: staleMilliseconds,
      update: updateMilliseconds,
    })
  } catch (error) {
    if (hasErrorCode(error, 'ELOCKED')) {
      return null
    }
    throw error
  }
}

async function ensureTarget(path: string): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true })
  await writeFile(path, '', { encoding: 'utf-8', flag: 'a', mode: 0o600 })
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal | undefined
): Promise<void> {
  if (signal?.aborted === true) {
    return
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, milliseconds)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true }
    )
  })
}
