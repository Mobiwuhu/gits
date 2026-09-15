import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

import { Inject } from '@wendellhu/redi'

import {
  ConfigurationError,
  GitsError,
  ITaskScaffoldService,
  UsageError,
} from '../../../contract/index'
import type {
  ITaskTemplateImportService,
  TaskConfiguration,
} from '../../../contract/index'
import { parseTaskConfiguration } from './TaskConfigurationService'

const configurationFileName = 'task.config.jsonc'
const repositoriesDirectoryName = 'repos'

enum ImportEntryKind {
  Directory = 'directory',
  File = 'file',
}

interface ImportEntry {
  readonly kind: ImportEntryKind
  readonly relativePath: string
  readonly sourcePath: string
  readonly targetPath: string
}

export class TaskTemplateImportService implements ITaskTemplateImportService {
  constructor(
    @Inject(ITaskScaffoldService)
    private readonly scaffold: ITaskScaffoldService
  ) {}

  async importTemplate(
    sourceRoot: string,
    targetRoot: string
  ): Promise<TaskConfiguration> {
    const source = resolve(sourceRoot)
    const target = resolve(targetRoot)
    if (source === target) {
      throw new UsageError(
        '--scan source directory must differ from the target task directory.'
      )
    }

    await this.assertDirectory(
      source,
      'scan directory',
      'scan-directory-invalid'
    )

    const sourceConfigurationPath = resolve(source, configurationFileName)
    const targetConfigurationPath = resolve(target, configurationFileName)
    const content = await this.readSourceConfiguration(sourceConfigurationPath)
    const configuration = parseTaskConfiguration(
      target,
      targetConfigurationPath,
      content
    )
    const entries = await this.collectEntries(source, target)

    for (const entry of entries) {
      await this.assertTargetCanReceive(target, entry)
    }

    await this.importTransaction(target, entries)
    return configuration
  }

  private async collectEntries(
    source: string,
    target: string
  ): Promise<readonly ImportEntry[]> {
    const sourceEntries = await readdir(source, { withFileTypes: true })
    const entries: ImportEntry[] = []

    for (const sourceEntry of sourceEntries.toSorted((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (sourceEntry.name === repositoriesDirectoryName) {
        continue
      }

      const sourcePath = resolve(source, sourceEntry.name)
      const metadata = await lstat(sourcePath)
      let kind: ImportEntryKind
      if (metadata.isDirectory()) {
        kind = ImportEntryKind.Directory
      } else if (metadata.isFile() || metadata.isSymbolicLink()) {
        kind = ImportEntryKind.File
      } else {
        throw new GitsError(
          'scan-entry-invalid',
          `Source task entry is not a file or directory: ${sourcePath}`
        )
      }

      entries.push({
        kind,
        relativePath: sourceEntry.name,
        sourcePath,
        targetPath: resolve(target, sourceEntry.name),
      })
    }

    return entries
  }

  private async readSourceConfiguration(path: string): Promise<string> {
    try {
      return await readFile(path, 'utf-8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new GitsError(
        'scan-config-unavailable',
        `Cannot read source ${configurationFileName}: ${message}`
      )
    }
  }

  private async assertTargetCanReceive(
    targetRoot: string,
    entry: ImportEntry
  ): Promise<void> {
    if (!(await this.pathExists(entry.targetPath))) {
      return
    }

    const metadata = await lstat(entry.targetPath)
    const isReplaceable =
      entry.kind === ImportEntryKind.Directory
        ? metadata.isDirectory() &&
          (await this.isReplaceableScaffoldDirectory(
            targetRoot,
            entry.targetPath
          ))
        : metadata.isFile() &&
          (await this.isReplaceableScaffoldFile(
            targetRoot,
            entry.relativePath,
            await readFile(entry.targetPath, 'utf-8')
          ))

    if (!isReplaceable) {
      throw new ConfigurationError(
        `Target ${entry.relativePath} contains non-default content; refusing to overwrite it.`
      )
    }
  }

  private async isReplaceableScaffoldDirectory(
    root: string,
    path: string
  ): Promise<boolean> {
    const entries = await readdir(path, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = resolve(path, entry.name)
      if (entry.isDirectory()) {
        if (!(await this.isReplaceableScaffoldDirectory(root, entryPath))) {
          return false
        }
        continue
      }
      if (!entry.isFile()) {
        return false
      }

      const relativePath = relative(root, entryPath).split(sep).join('/')
      const content = await readFile(entryPath, 'utf-8')
      if (
        !(await this.isReplaceableScaffoldFile(root, relativePath, content))
      ) {
        return false
      }
    }
    return true
  }

  private async isReplaceableScaffoldFile(
    root: string,
    relativePath: string,
    content: string
  ): Promise<boolean> {
    return (
      content.length === 0 ||
      this.scaffold.isDefaultContent(root, relativePath, content)
    )
  }

  private async importTransaction(
    target: string,
    entries: readonly ImportEntry[]
  ): Promise<void> {
    const transactionPath = resolve(
      target,
      `.gits-import-${process.pid}-${Date.now()}`
    )
    const stagedRoot = resolve(transactionPath, 'staged')
    const backupRoot = resolve(transactionPath, 'backup')
    const movedEntries: ImportEntry[] = []
    const writtenEntries: ImportEntry[] = []

    try {
      await mkdir(stagedRoot, { recursive: true })
      await mkdir(backupRoot, { recursive: true })

      for (const entry of entries) {
        await this.stageEntry(stagedRoot, entry)
      }
      for (const entry of entries) {
        if (!(await this.pathExists(entry.targetPath))) {
          continue
        }
        const backupPath = resolve(backupRoot, entry.relativePath)
        await mkdir(dirname(backupPath), { recursive: true })
        await rename(entry.targetPath, backupPath)
        movedEntries.push(entry)
      }
      for (const entry of entries) {
        const stagedPath = resolve(stagedRoot, entry.relativePath)
        await mkdir(dirname(entry.targetPath), { recursive: true })
        await rename(stagedPath, entry.targetPath)
        writtenEntries.push(entry)
      }
    } catch (error) {
      await this.rollback(backupRoot, movedEntries, writtenEntries)
      const message = error instanceof Error ? error.message : String(error)
      throw new GitsError(
        'template-import-failed',
        `Cannot import task template: ${message}`
      )
    } finally {
      await rm(transactionPath, { force: true, recursive: true })
    }
  }

  private async stageEntry(
    stagedRoot: string,
    entry: ImportEntry
  ): Promise<void> {
    const stagedPath = resolve(stagedRoot, entry.relativePath)
    await mkdir(dirname(stagedPath), { recursive: true })
    await cp(entry.sourcePath, stagedPath, {
      dereference: false,
      errorOnExist: true,
      force: false,
      recursive: true,
    })
  }

  private async rollback(
    backupRoot: string,
    movedEntries: readonly ImportEntry[],
    writtenEntries: readonly ImportEntry[]
  ): Promise<void> {
    try {
      for (const entry of writtenEntries.toReversed()) {
        await rm(entry.targetPath, { force: true, recursive: true })
      }
      for (const entry of movedEntries.toReversed()) {
        const backupPath = resolve(backupRoot, entry.relativePath)
        await mkdir(dirname(entry.targetPath), { recursive: true })
        await rename(backupPath, entry.targetPath)
      }
    } catch {
      // 保留原始导入错误，恢复现场可供后续人工检查。
    }
  }

  private async assertDirectory(
    path: string,
    label: string,
    code: string
  ): Promise<void> {
    try {
      const metadata = await stat(path)
      if (!metadata.isDirectory()) {
        throw new GitsError(code, `${label} is not a directory: ${path}`)
      }
    } catch (error) {
      if (error instanceof GitsError) {
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new GitsError(code, `Cannot access ${label} ${path}: ${message}`)
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path)
      return true
    } catch {
      return false
    }
  }
}
