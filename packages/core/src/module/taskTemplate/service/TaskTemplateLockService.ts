import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import lockfile from '@bybrave/proper-lockfile2'
import { Inject } from '@wendellhu/redi'

import { IGitsPathService } from '../../../contract/index'
import type {
  ITaskTemplateLockService,
  TaskTemplateLockRelease,
} from '../../../contract/index'
import { hasErrorCode } from '../../../util/index'
import { assertTaskTemplateName } from './taskTemplateHelpers'

const staleMilliseconds = 60_000
const updateMilliseconds = 10_000

export class TaskTemplateLockService implements ITaskTemplateLockService {
  constructor(
    @Inject(IGitsPathService) private readonly paths: IGitsPathService
  ) {}

  async acquire(name: string): Promise<TaskTemplateLockRelease | null> {
    assertTaskTemplateName(name)
    const target = resolve(this.paths.locks, 'templates', name)
    await mkdir(dirname(target), { mode: 0o700, recursive: true })
    await writeFile(target, '', { encoding: 'utf-8', flag: 'a', mode: 0o600 })
    try {
      return await lockfile.lock(target, {
        retries: 0,
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

  async acquireMany(
    names: readonly string[]
  ): Promise<TaskTemplateLockRelease | null> {
    const releases: TaskTemplateLockRelease[] = []
    for (const name of [...new Set(names)].toSorted()) {
      const release = await this.acquire(name)
      if (release === null) {
        await releaseAll(releases)
        return null
      }
      releases.push(release)
    }
    return async () => releaseAll(releases)
  }
}

async function releaseAll(
  releases: readonly TaskTemplateLockRelease[]
): Promise<void> {
  for (const release of releases.toReversed()) {
    await release()
  }
}
