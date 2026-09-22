import { mkdir, rename } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  ConcurrentRunStatus,
  RepoMirrorAction,
  RepoMirrorUsageError,
} from '../../../contract/index'
import type {
  ConcurrentRunResult,
  GitsPaths,
  RepoMirrorCommandError,
  RepoMirrorView,
} from '../../../contract/index'

export async function settledViews<T>(
  entries: readonly ConcurrentRunResult<T, RepoMirrorView>[],
  notRun: (item: T) => Promise<RepoMirrorView>
): Promise<readonly RepoMirrorView[]> {
  return Promise.all(
    entries.map(async (entry) => {
      if (entry.status === ConcurrentRunStatus.Fulfilled) {
        return entry.value
      }
      if (entry.status === ConcurrentRunStatus.NotRun) {
        return notRun(entry.item)
      }
      const message =
        entry.error instanceof Error ? entry.error.message : String(entry.error)
      return {
        ...(await notRun(entry.item)),
        action: RepoMirrorAction.Failed,
        error: commandError('repo-mirror-operation-failed', message),
      }
    })
  )
}

export async function moveToTrash(
  path: string,
  name: string,
  paths: GitsPaths
): Promise<string> {
  await mkdir(paths.trash, { mode: 0o700, recursive: true })
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, '')
  const destination = resolve(paths.trash, `${timestamp}-${name}.git`)
  await rename(path, destination)
  return destination
}

export function commandError(
  code: string,
  message: string
): RepoMirrorCommandError {
  return { code, message }
}

export function operationMessage(
  commands: readonly { readonly stderr: string; readonly stdout: string }[]
): string {
  const command = commands.at(-1)
  return command === undefined
    ? 'Git operation failed.'
    : command.stderr.trim() || command.stdout.trim() || 'Git operation failed.'
}

export function commandMessage(command: {
  readonly stderr: string
  readonly stdout: string
}): string {
  return command.stderr.trim() || command.stdout.trim() || 'Git command failed.'
}

export function asNonEmptyUrls(
  values: readonly string[]
): readonly [string, ...string[]] {
  const [first] = values
  if (first === undefined) {
    throw new RepoMirrorUsageError('Mirror URL list cannot be empty.')
  }
  return [first, ...values.slice(1)]
}

export function validateJobs(jobs: number | undefined): void {
  if (
    jobs !== undefined &&
    (!Number.isInteger(jobs) || jobs < 1 || jobs > 32)
  ) {
    throw new RepoMirrorUsageError('--jobs must be an integer from 1 to 32.')
  }
}
