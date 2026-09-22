import { randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { Inject } from '@wendellhu/redi'

import {
  GitsError,
  ITaskScaffoldService,
  TaskDirectoryEntryKind,
} from '../../../contract/index'
import type {
  ITaskDirectoryMaterializationService,
  MaterializationEntry,
  MaterializeTaskDirectoryInput,
} from '../../../contract/index'
import {
  canonicalizePath,
  hasErrorCode,
  isAbortError,
  pathEntryExists,
  throwIfAborted,
} from '../../../util/index'

interface ExistingDecision {
  readonly entry: MaterializationEntry
  readonly existing: ExistingEntryState
  readonly targetPath: string
}

enum ExistingEntryState {
  Absent = 'absent',
  Directory = 'directory',
  Replace = 'replace',
  Same = 'same',
}

export class TaskDirectoryMaterializationService implements ITaskDirectoryMaterializationService {
  constructor(
    @Inject(ITaskScaffoldService)
    private readonly scaffold: ITaskScaffoldService
  ) {}

  async materialize(input: MaterializeTaskDirectoryInput): Promise<void> {
    const root = await canonicalizePath(input.root)
    const entries = validatePlan(input.entries)
    const decisions = await this.preflight(root, entries)
    if (input.dryRun) {
      return
    }
    throwIfAborted(input.signal)

    const transactionRoot = resolve(
      dirname(root),
      `.gits-materialize-${process.pid}-${randomUUID()}`
    )
    const stagedRoot = resolve(transactionRoot, 'staged')
    const backupRoot = resolve(transactionRoot, 'backup')
    const written: string[] = []
    const backups: { readonly backup: string; readonly target: string }[] = []
    const createdDirectories: string[] = []
    let preserveTransaction = false

    try {
      await mkdir(stagedRoot, { mode: 0o700, recursive: true })
      await mkdir(backupRoot, { mode: 0o700, recursive: true })
      await this.stage(stagedRoot, entries, input.signal)
      if (!(await pathEntryExists(root))) {
        await mkdir(root, { mode: 0o700 })
        createdDirectories.push(root)
      }

      for (const decision of decisions) {
        throwIfAborted(input.signal)
        const { entry, targetPath } = decision
        if (entry.kind === TaskDirectoryEntryKind.Directory) {
          if (decision.existing === ExistingEntryState.Absent) {
            await mkdir(targetPath, { mode: entry.mode & 0o777 })
            await chmod(targetPath, entry.mode & 0o777)
            createdDirectories.push(targetPath)
          }
          continue
        }
        if (decision.existing === ExistingEntryState.Same) {
          continue
        }
        await mkdir(dirname(targetPath), { mode: 0o700, recursive: true })
        if (decision.existing === ExistingEntryState.Replace) {
          const backup = resolve(backupRoot, entry.relativePath)
          await mkdir(dirname(backup), { mode: 0o700, recursive: true })
          await rename(targetPath, backup)
          backups.push({ backup, target: targetPath })
        }
        const staged = resolve(stagedRoot, entry.relativePath)
        await rename(staged, targetPath)
        written.push(targetPath)
      }
    } catch (error) {
      const rolledBack = await rollback(written, backups, createdDirectories)
      preserveTransaction = !rolledBack
      const recovery = rolledBack
        ? ''
        : ` Rollback was incomplete; recovery data remains at ${transactionRoot}.`
      if (error instanceof GitsError || isAbortError(error)) {
        if (recovery.length > 0) {
          if (error instanceof GitsError) {
            throw new GitsError(
              error.code,
              `${error.message}${recovery}`,
              error.exitCode
            )
          }
          const interrupted = new Error(`${error.message}${recovery}`)
          interrupted.name = 'AbortError'
          throw interrupted
        }
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new GitsError(
        'template-operation-failed',
        `Cannot materialize task directory: ${message}${recovery}`
      )
    } finally {
      if (!preserveTransaction) {
        await rm(transactionRoot, { force: true, recursive: true })
      }
    }
  }

  private async preflight(
    root: string,
    entries: readonly MaterializationEntry[]
  ): Promise<readonly ExistingDecision[]> {
    try {
      const rootMetadata = await lstat(root)
      if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
        throw new GitsError(
          'template-target-conflict',
          `Task target must be a real directory: ${root}`
        )
      }
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error
      }
    }

    const decisions: ExistingDecision[] = []
    for (const entry of entries) {
      const targetPath = resolveInside(root, entry.relativePath)
      await assertSafeAncestors(root, targetPath)
      let metadata: Awaited<ReturnType<typeof lstat>>
      try {
        metadata = await lstat(targetPath)
      } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
          decisions.push({
            entry,
            existing: ExistingEntryState.Absent,
            targetPath,
          })
          continue
        }
        throw error
      }

      if (
        entry.kind === TaskDirectoryEntryKind.Directory &&
        metadata.isDirectory()
      ) {
        decisions.push({
          entry,
          existing: ExistingEntryState.Directory,
          targetPath,
        })
        continue
      }
      if (entry.kind === TaskDirectoryEntryKind.File && metadata.isFile()) {
        const existing = await readFile(targetPath)
        const desired = await entryContent(entry)
        if (existing.equals(desired)) {
          decisions.push({
            entry,
            existing: ExistingEntryState.Same,
            targetPath,
          })
          continue
        }
        const text = existing.toString('utf-8')
        if (
          await this.scaffold.isDefaultContent(root, entry.relativePath, text)
        ) {
          decisions.push({
            entry,
            existing: ExistingEntryState.Replace,
            targetPath,
          })
          continue
        }
      }
      if (
        entry.kind === TaskDirectoryEntryKind.Symlink &&
        metadata.isSymbolicLink()
      ) {
        const target = await readlink(targetPath)
        if (target === entry.linkTarget) {
          decisions.push({
            entry,
            existing: ExistingEntryState.Same,
            targetPath,
          })
          continue
        }
      }
      throw new GitsError(
        'template-target-conflict',
        `Target ${entry.relativePath} contains non-default content or has the wrong path type; refusing to overwrite it.`
      )
    }
    return decisions
  }

  private async stage(
    stagedRoot: string,
    entries: readonly MaterializationEntry[],
    signal: AbortSignal | undefined
  ): Promise<void> {
    for (const entry of entries) {
      throwIfAborted(signal)
      const target = resolve(stagedRoot, entry.relativePath)
      if (entry.kind === TaskDirectoryEntryKind.Directory) {
        await mkdir(target, { mode: entry.mode & 0o777, recursive: true })
        continue
      }
      await mkdir(dirname(target), { mode: 0o700, recursive: true })
      if (entry.kind === TaskDirectoryEntryKind.Symlink) {
        if (entry.linkTarget === undefined) {
          throw new GitsError(
            'template-entry-invalid',
            `Symbolic link target is missing for ${entry.relativePath}.`
          )
        }
        await symlink(entry.linkTarget, target)
        continue
      }
      if (entry.sourcePath !== undefined) {
        await copyFile(entry.sourcePath, target)
      } else if (entry.content !== undefined) {
        await writeFile(target, entry.content, {
          encoding: 'utf-8',
          flag: 'wx',
        })
      } else {
        throw new GitsError(
          'template-entry-invalid',
          `File content is missing for ${entry.relativePath}.`
        )
      }
      await chmod(target, entry.mode & 0o777)
    }
  }
}

function validatePlan(
  entries: readonly MaterializationEntry[]
): readonly MaterializationEntry[] {
  const paths = new Map<string, MaterializationEntry>()
  for (const entry of entries) {
    const segments = entry.relativePath.split('/')
    if (
      entry.relativePath.length === 0 ||
      isAbsolute(entry.relativePath) ||
      entry.relativePath.includes('\\') ||
      segments.some(
        (segment) => segment.length === 0 || segment === '.' || segment === '..'
      )
    ) {
      throw new GitsError(
        'template-entry-invalid',
        `Invalid materialization path: ${entry.relativePath}`
      )
    }
    if (paths.has(entry.relativePath)) {
      throw new GitsError(
        'template-entry-invalid',
        `Duplicate materialization path: ${entry.relativePath}`
      )
    }
    paths.set(entry.relativePath, entry)
  }
  for (const entry of entries) {
    let parent = dirname(entry.relativePath).split(sep).join('/')
    while (parent !== '.' && parent.length > 0) {
      const parentEntry = paths.get(parent)
      if (
        parentEntry !== undefined &&
        parentEntry.kind !== TaskDirectoryEntryKind.Directory
      ) {
        throw new GitsError(
          'template-entry-invalid',
          `Materialization path ${entry.relativePath} is nested below non-directory ${parent}.`
        )
      }
      parent = dirname(parent).split(sep).join('/')
    }
  }
  return [...entries].toSorted((left, right) => {
    if (
      left.kind === TaskDirectoryEntryKind.Directory &&
      right.kind !== TaskDirectoryEntryKind.Directory
    ) {
      return -1
    }
    if (
      left.kind !== TaskDirectoryEntryKind.Directory &&
      right.kind === TaskDirectoryEntryKind.Directory
    ) {
      return 1
    }
    const depth =
      left.relativePath.split('/').length - right.relativePath.split('/').length
    return depth === 0
      ? left.relativePath.localeCompare(right.relativePath)
      : depth
  })
}

function resolveInside(root: string, relativePath: string): string {
  const path = resolve(root, relativePath)
  const fromRoot = relative(root, path)
  if (
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new GitsError(
      'template-entry-invalid',
      `Materialization path escapes target: ${relativePath}`
    )
  }
  return path
}

async function assertSafeAncestors(root: string, path: string): Promise<void> {
  let current = dirname(path)
  while (current !== dirname(root)) {
    try {
      const metadata = await lstat(current)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new GitsError(
          'template-target-conflict',
          `Target ancestor is not a real directory: ${current}`
        )
      }
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error
      }
    }
    if (current === root) {
      return
    }
    const parent = dirname(current)
    if (parent === current) {
      return
    }
    current = parent
  }
}

async function entryContent(entry: MaterializationEntry): Promise<Buffer> {
  if (entry.sourcePath !== undefined) {
    return readFile(entry.sourcePath)
  }
  if (entry.content !== undefined) {
    return Buffer.from(entry.content)
  }
  throw new GitsError(
    'template-entry-invalid',
    `File content is missing for ${entry.relativePath}.`
  )
}

async function rollback(
  written: readonly string[],
  backups: readonly { readonly backup: string; readonly target: string }[],
  createdDirectories: readonly string[]
): Promise<boolean> {
  let succeeded = true
  for (const path of written.toReversed()) {
    try {
      await rm(path, { force: true, recursive: true })
    } catch {
      succeeded = false
    }
  }
  for (const entry of backups.toReversed()) {
    try {
      await mkdir(dirname(entry.target), { mode: 0o700, recursive: true })
      await rename(entry.backup, entry.target)
    } catch {
      succeeded = false
    }
  }
  for (const path of createdDirectories.toReversed()) {
    try {
      await rmdir(path)
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT') && !hasErrorCode(error, 'ENOTEMPTY')) {
        succeeded = false
      }
    }
  }
  return succeeded
}
