import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import lockfile from '@bybrave/proper-lockfile2'

import { Inject } from '@wendellhu/redi'

import {
  IGitsPathService,
  type IRepoMirrorLockService,
  type RepoMirrorLockRelease,
} from '../../../contract/index'

const staleMilliseconds = 60_000
const updateMilliseconds = 10_000

export class RepoMirrorLockService implements IRepoMirrorLockService {
  constructor(@Inject(IGitsPathService) private readonly paths: IGitsPathService) {}

  async acquireConfig(): Promise<RepoMirrorLockRelease> {
    const target = resolve(this.paths.locks, 'config')
    await ensureTarget(target)
    return lockfile.lock(target, {
      retries: { factor: 1.4, maxTimeout: 250, minTimeout: 25, retries: 20 },
      stale: staleMilliseconds,
      update: updateMilliseconds,
    })
  }

  async acquireMirror(
    name: string,
    options: Readonly<{ wait?: boolean }> = {},
  ): Promise<RepoMirrorLockRelease | null> {
    const target = resolve(this.paths.locks, 'repo-mirrors', name)
    await ensureTarget(target)
    return tryLock(target, options.wait === true ? 20 : 0)
  }

  async acquireFetchSlot(
    maximum: number,
    options: Readonly<{ signal?: AbortSignal; wait?: boolean }> = {},
  ): Promise<RepoMirrorLockRelease | null> {
    const attempts = options.wait === false ? 1 : 101
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (options.signal?.aborted === true) return null
      for (let slot = 0; slot < maximum; slot += 1) {
        const target = resolve(this.paths.locks, 'fetch-slots', String(slot))
        await ensureTarget(target)
        const release = await tryLock(target, 0)
        if (release !== null) return release
      }
      if (attempt + 1 < attempts) await abortableDelay(100, options.signal)
    }
    return null
  }
}

async function tryLock(target: string, retries: number): Promise<RepoMirrorLockRelease | null> {
  try {
    return await lockfile.lock(target, {
      retries,
      stale: staleMilliseconds,
      update: updateMilliseconds,
    })
  } catch (error) {
    if (hasCode(error, 'ELOCKED')) return null
    throw error
  }
}

async function ensureTarget(path: string): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true })
  await writeFile(path, '', { encoding: 'utf8', flag: 'a', mode: 0o600 })
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted === true) return
  await new Promise<void>((resolveDelay) => {
    const timeout = setTimeout(resolveDelay, milliseconds)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        resolveDelay()
      },
      { once: true },
    )
  })
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
