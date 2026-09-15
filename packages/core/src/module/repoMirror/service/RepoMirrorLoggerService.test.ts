import assert from 'node:assert/strict'
import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

import {
  RepoMirrorInvocationSource,
  RepoMirrorLastRunStatus,
} from '../../../contract/index'
import { FileSystemService, GitsPathService } from '../../../service/index'
import { RepoMirrorLoggerService } from './RepoMirrorLoggerService'

void describe('pino repo mirror logger retention', () => {
  void it('keeps only the configured number of completed runs per mirror', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-log-count-test-'))
    try {
      const paths = new GitsPathService({
        environment: { GITS_HOME: resolve(root, 'gits-home') },
      })
      const logger = new RepoMirrorLoggerService(
        paths,
        new FileSystemService(),
        {
          maximumCompletedBytesGlobally: 1024 * 1024,
          maximumCompletedBytesPerMirror: 1024 * 1024,
          maximumCompletedRuns: 2,
        }
      )

      for (let run = 0; run < 3; run += 1) {
        // 串行完成每轮日志，使保留策略能处理上一轮结果。
        const session = await logger.start(
          'api',
          RepoMirrorInvocationSource.Manual
        )
        session.event({ durationMs: run, exitCode: 0 })
        await session.finish(RepoMirrorLastRunStatus.Success)
      }

      const logs = await completedLogs(resolve(paths.logs, 'api'))
      const lastRun = await logger.readLastRun('api')
      assert.equal(logs.length, 2)
      assert.equal(lastRun?.status, RepoMirrorLastRunStatus.Success)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('enforces per-mirror and global byte ceilings for completed logs', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-log-bytes-test-'))
    try {
      const paths = new GitsPathService({
        environment: { GITS_HOME: resolve(root, 'gits-home') },
      })
      const perMirrorLogger = new RepoMirrorLoggerService(
        paths,
        new FileSystemService(),
        {
          maximumCompletedBytesGlobally: 1024 * 1024,
          maximumCompletedBytesPerMirror: 1,
        }
      )
      const perMirrorSession = await perMirrorLogger.start(
        'api',
        RepoMirrorInvocationSource.Manual
      )
      await perMirrorSession.finish(RepoMirrorLastRunStatus.Success)
      assert.deepEqual(await completedLogs(resolve(paths.logs, 'api')), [])

      const globalLogger = new RepoMirrorLoggerService(
        paths,
        new FileSystemService(),
        {
          maximumCompletedBytesGlobally: 1,
          maximumCompletedBytesPerMirror: 1024 * 1024,
        }
      )
      const globalSession = await globalLogger.start(
        'web',
        RepoMirrorInvocationSource.Scheduler
      )
      await globalSession.finish(RepoMirrorLastRunStatus.Success)
      assert.deepEqual(await completedLogs(resolve(paths.logs, 'web')), [])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('removes abandoned active logs without deleting a plausible live writer', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-active-log-test-'))
    try {
      const paths = new GitsPathService({
        environment: { GITS_HOME: resolve(root, 'gits-home') },
      })
      const logger = new RepoMirrorLoggerService(
        paths,
        new FileSystemService(),
        {
          maximumActiveAgeMs: 2000,
          staleActiveAgeMs: 1000,
        }
      )
      const directory = resolve(paths.logs, 'api')
      await mkdir(directory, { recursive: true })
      const staleLegacy = resolve(directory, 'legacy.active.jsonl')
      const recentLegacy = resolve(directory, 'recent.active.jsonl')
      const liveOwner = resolve(
        directory,
        `20260910T000000Z-${process.pid}-00000000-0000-0000-0000-000000000001.active.jsonl`
      )
      const expiredOwner = resolve(
        directory,
        `20260910T000000Z-${process.pid}-00000000-0000-0000-0000-000000000002.active.jsonl`
      )
      await Promise.all(
        [staleLegacy, recentLegacy, liveOwner, expiredOwner].map(async (path) =>
          writeFile(path, '{}\n')
        )
      )
      const now = Date.now()
      await Promise.all([
        utimes(staleLegacy, new Date(now - 1500), new Date(now - 1500)),
        utimes(liveOwner, new Date(now - 1500), new Date(now - 1500)),
        utimes(expiredOwner, new Date(now - 3000), new Date(now - 3000)),
      ])

      const session = await logger.start(
        'api',
        RepoMirrorInvocationSource.Manual
      )
      assert.equal(await exists(staleLegacy), false)
      assert.equal(await exists(recentLegacy), true)
      assert.equal(await exists(liveOwner), true)
      assert.equal(await exists(expiredOwner), false)
      await session.finish(RepoMirrorLastRunStatus.Success)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

async function completedLogs(directory: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(directory)
    return entries.filter(
      (entry) => entry.endsWith('.jsonl') && !entry.endsWith('.active.jsonl')
    )
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return []
    }
    throw error
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return false
    }
    throw error
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  )
}
