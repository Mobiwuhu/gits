import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { Inject } from '@wendellhu/redi'
import pino from 'pino'
import type { Logger } from 'pino'

import {
  IFileSystemService,
  IGitsPathService,
  RepoMirrorInvocationSource,
  RepoMirrorLastRunStatus,
} from '../../../contract/index'
import type {
  IRepoMirrorLoggerService,
  RepoMirrorLogSession,
  RepoMirrorRunState,
} from '../../../contract/index'
import { hasErrorCode } from '../../../util/index'

const mebibyte = 1024 * 1024
const day = 24 * 60 * 60 * 1000

export interface RepoMirrorLogRetentionPolicy {
  readonly maximumActiveAgeMs: number
  readonly maximumCompletedBytesGlobally: number
  readonly maximumCompletedBytesPerMirror: number
  readonly maximumCompletedRuns: number
  readonly staleActiveAgeMs: number
}

export const defaultRepoMirrorLogRetentionPolicy: RepoMirrorLogRetentionPolicy =
  {
    maximumActiveAgeMs: 7 * day,
    maximumCompletedBytesGlobally: 256 * mebibyte,
    maximumCompletedBytesPerMirror: 10 * mebibyte,
    maximumCompletedRuns: 20,
    staleActiveAgeMs: day,
  }

interface RetainedLogFile {
  readonly modifiedAt: number
  readonly path: string
  readonly size: number
}

export class RepoMirrorLoggerService implements IRepoMirrorLoggerService {
  readonly #retention: RepoMirrorLogRetentionPolicy

  constructor(
    @Inject(IGitsPathService) private readonly paths: IGitsPathService,
    @Inject(IFileSystemService) private readonly fileSystem: IFileSystemService,
    retention: Partial<RepoMirrorLogRetentionPolicy> = {}
  ) {
    this.#retention = { ...defaultRepoMirrorLogRetentionPolicy, ...retention }
  }

  async start(
    name: string,
    source: RepoMirrorInvocationSource
  ): Promise<RepoMirrorLogSession> {
    const directory = this.logDirectory(name)
    await mkdir(directory, { mode: 0o700, recursive: true })
    await removeStaleActiveLogs(directory, this.#retention)
    const startedAt = new Date().toISOString()
    const stem = `${compactTimestamp(startedAt)}-${process.pid}-${randomUUID()}`
    const activePath = resolve(directory, `${stem}.active.jsonl`)
    const completedPath = resolve(directory, `${stem}.jsonl`)
    const destination = pino.destination({
      dest: activePath,
      mkdir: true,
      mode: 0o600,
      sync: true,
    })
    const logger = pino(
      {
        base: { mirror: name, source },
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      destination
    )
    logger.info({ event: 'start' })
    return new PinoLogSession(
      logger,
      activePath,
      completedPath,
      this.statePath(name),
      directory,
      this.paths.logs,
      this.#retention,
      source,
      startedAt,
      this.fileSystem
    )
  }

  async readLastRun(name: string): Promise<RepoMirrorRunState | null> {
    try {
      const value: unknown = JSON.parse(
        await readFile(this.statePath(name), 'utf-8')
      )
      return isRunState(value) ? value : null
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return null
      }
      throw error
    }
  }

  async readLines(name: string, maximum: number): Promise<readonly string[]> {
    const directory = this.logDirectory(name)
    let entries: string[]
    try {
      const directoryEntries = await readdir(directory)
      entries = directoryEntries
        .filter((entry) => entry.endsWith('.jsonl'))
        .toSorted()
        .toReversed()
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return []
      }
      throw error
    }

    const contents = await Promise.all(
      entries.map(async (entry): Promise<string | null> => {
        try {
          return await readFile(resolve(directory, entry), 'utf-8')
        } catch (error) {
          if (hasErrorCode(error, 'ENOENT')) {
            return null
          }
          throw error
        }
      })
    )
    const lines: string[] = []
    for (const content of contents) {
      if (content === null) {
        continue
      }
      const fileLines = content
        .split(/\r?\n/u)
        .filter((line) => line.length > 0)
      lines.unshift(
        ...fileLines.slice(
          Math.max(0, fileLines.length - (maximum - lines.length))
        )
      )
      if (lines.length >= maximum) {
        return lines.slice(-maximum)
      }
    }
    return lines.slice(-maximum)
  }

  private logDirectory(name: string): string {
    return resolve(this.paths.logs, name)
  }

  private statePath(name: string): string {
    return resolve(this.paths.mirrorState, `${name}.json`)
  }
}

class PinoLogSession implements RepoMirrorLogSession {
  readonly startedAt: string
  readonly #activePath: string
  readonly #completedPath: string
  readonly #directory: string
  readonly #logger: Logger
  readonly #logsRoot: string
  readonly #retention: RepoMirrorLogRetentionPolicy
  readonly #source: RepoMirrorInvocationSource
  readonly #statePath: string
  readonly #fileSystem: IFileSystemService

  constructor(
    logger: Logger,
    activePath: string,
    completedPath: string,
    statePath: string,
    directory: string,
    logsRoot: string,
    retention: RepoMirrorLogRetentionPolicy,
    source: RepoMirrorInvocationSource,
    startedAt: string,
    fileSystem: IFileSystemService
  ) {
    this.#logger = logger
    this.#activePath = activePath
    this.#completedPath = completedPath
    this.#statePath = statePath
    this.#directory = directory
    this.#logsRoot = logsRoot
    this.#retention = retention
    this.#source = source
    this.startedAt = startedAt
    this.#fileSystem = fileSystem
  }

  event(
    command: Readonly<{ durationMs: number; exitCode: number | null }>
  ): void {
    this.#logger.info(
      {
        durationMs: Math.round(command.durationMs),
        event: 'git-command',
        exitCode: command.exitCode,
      },
      'Git command completed'
    )
  }

  async finish(
    status: RepoMirrorLastRunStatus,
    options: Readonly<{ error?: string }> = {}
  ): Promise<RepoMirrorRunState> {
    const finishedAt = new Date().toISOString()
    const durationMs = Math.max(
      0,
      Date.parse(finishedAt) - Date.parse(this.startedAt)
    )
    const error =
      options.error === undefined ? undefined : sanitize(options.error)
    this.#logger[status === RepoMirrorLastRunStatus.Failed ? 'error' : 'info'](
      {
        durationMs,
        event: 'finish',
        ...(error === undefined ? {} : { error }),
        status,
      },
      'Repo mirror run finished'
    )
    this.#logger.flush()
    await rename(this.#activePath, this.#completedPath)

    const previous = await readPreviousState(this.#statePath)
    const succeededAt =
      status === RepoMirrorLastRunStatus.Success
        ? finishedAt
        : previous?.succeededAt
    const state: RepoMirrorRunState = {
      attemptedAt: this.startedAt,
      durationMs,
      ...(error === undefined ? {} : { error }),
      finishedAt,
      source: this.#source,
      status,
      ...(succeededAt === undefined ? {} : { succeededAt }),
    }
    await this.#fileSystem.writeFileAtomically(
      this.#statePath,
      `${JSON.stringify(state, null, 2)}\n`
    )
    await retainCompletedLogs(this.#directory, this.#retention)
    await retainGlobalLogs(this.#logsRoot, this.#retention)
    return state
  }
}

async function retainCompletedLogs(
  directory: string,
  retention: RepoMirrorLogRetentionPolicy
): Promise<void> {
  const completedLogs = await listCompletedLogs(directory)
  const files = completedLogs.toSorted(compareNewestFirst)
  let bytes = 0
  let runs = 0
  const expired: string[] = []
  for (const file of files) {
    if (
      runs >= retention.maximumCompletedRuns ||
      bytes + file.size > retention.maximumCompletedBytesPerMirror
    ) {
      expired.push(file.path)
      continue
    }
    bytes += file.size
    runs += 1
  }
  await Promise.all(expired.map(async (path) => rm(path, { force: true })))
}

async function retainGlobalLogs(
  logsRoot: string,
  retention: RepoMirrorLogRetentionPolicy
): Promise<void> {
  let directories
  try {
    const entries = await readdir(logsRoot, { withFileTypes: true })
    directories = entries.filter((entry) => entry.isDirectory())
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return
    }
    throw error
  }

  const now = Date.now()
  const completedLogGroups = await Promise.all(
    directories.map(async (directory) => {
      const path = resolve(logsRoot, directory.name)
      await removeStaleActiveLogs(path, retention, now)
      return listCompletedLogs(path)
    })
  )
  const files = completedLogGroups.flat()

  let bytes = files.reduce((total, file) => total + file.size, 0)
  const expired: string[] = []
  for (const file of files.toSorted(compareOldestFirst)) {
    if (bytes <= retention.maximumCompletedBytesGlobally) {
      break
    }
    expired.push(file.path)
    bytes -= file.size
  }
  await Promise.all(expired.map(async (path) => rm(path, { force: true })))
}

async function listCompletedLogs(
  directory: string
): Promise<readonly RetainedLogFile[]> {
  let entries: string[]
  try {
    const directoryEntries = await readdir(directory)
    entries = directoryEntries.filter(
      (entry) => entry.endsWith('.jsonl') && !entry.endsWith('.active.jsonl')
    )
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return []
    }
    throw error
  }

  const files = await Promise.all(
    entries.map(async (entry): Promise<RetainedLogFile | null> => {
      const path = resolve(directory, entry)
      try {
        const metadata = await stat(path)
        return { modifiedAt: metadata.mtimeMs, path, size: metadata.size }
      } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
          return null
        }
        throw error
      }
    })
  )
  return files.filter((file): file is RetainedLogFile => file !== null)
}

async function removeStaleActiveLogs(
  directory: string,
  retention: RepoMirrorLogRetentionPolicy,
  now = Date.now()
): Promise<void> {
  let entries: string[]
  try {
    const directoryEntries = await readdir(directory)
    entries = directoryEntries.filter((entry) =>
      entry.endsWith('.active.jsonl')
    )
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return
    }
    throw error
  }

  await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry)
      try {
        const metadata = await stat(path)
        const age = Math.max(0, now - metadata.mtimeMs)
        const owner = activeLogProcessId(entry)
        const ownerCanStillBeRunning = owner !== null && isProcessAlive(owner)
        if (
          age >= retention.maximumActiveAgeMs ||
          (age >= retention.staleActiveAgeMs && !ownerCanStillBeRunning)
        ) {
          await rm(path, { force: true })
        }
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) {
          throw error
        }
      }
    })
  )
}

function activeLogProcessId(name: string): number | null {
  const match = /T\d{6}Z-(?<processId>\d+)-[\da-f-]+\.active\.jsonl$/u.exec(
    name
  )
  const processId = match?.groups?.processId
  if (processId === undefined) {
    return null
  }
  const value = Number(processId)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    return hasErrorCode(error, 'EPERM')
  }
}

function compareNewestFirst(
  left: RetainedLogFile,
  right: RetainedLogFile
): number {
  return (
    right.modifiedAt - left.modifiedAt || right.path.localeCompare(left.path)
  )
}

function compareOldestFirst(
  left: RetainedLogFile,
  right: RetainedLogFile
): number {
  return (
    left.modifiedAt - right.modifiedAt || left.path.localeCompare(right.path)
  )
}

async function readPreviousState(
  path: string
): Promise<RepoMirrorRunState | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf-8'))
    return isRunState(value) ? value : null
  } catch {
    return null
  }
}

function isRunState(value: unknown): value is RepoMirrorRunState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'attemptedAt' in value &&
    typeof value.attemptedAt === 'string' &&
    'durationMs' in value &&
    typeof value.durationMs === 'number' &&
    'finishedAt' in value &&
    typeof value.finishedAt === 'string' &&
    'source' in value &&
    isInvocationSource(value.source) &&
    'status' in value &&
    isLastRunStatus(value.status)
  )
}

function isInvocationSource(
  value: unknown
): value is RepoMirrorInvocationSource {
  return Object.values(RepoMirrorInvocationSource).some(
    (source) => source === value
  )
}

function isLastRunStatus(value: unknown): value is RepoMirrorLastRunStatus {
  return Object.values(RepoMirrorLastRunStatus).some(
    (status) => status === value
  )
}

function compactTimestamp(value: string): string {
  return value.replaceAll(/[-:]/gu, '').replace(/\.\d{3}/u, '')
}

function sanitize(value: string): string {
  return value
    .replaceAll(/https?:\/\/[^\s/@]+:[^\s/@]+@/giu, 'https://<redacted>@')
    .slice(0, 2000)
}
