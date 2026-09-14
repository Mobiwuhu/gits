import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import {
  ConfigurationError,
  GitsError,
  UsageError,
  type ITaskTemplateImportService,
  type TaskConfiguration,
} from '../../../contract/index'
import {
  isDefaultTaskConfigurationTemplate,
  parseTaskConfiguration,
} from './TaskConfigurationService'

const configurationFileName = 'task.config.jsonc'
const scriptsDirectoryName = 'scripts'
const agentConfigurationDirectories = [
  '.agents',
  '.codex',
  '.claude',
  '.gemini',
  '.grok',
  '.cursor',
  '.pi',
] as const
const agentConfigurationFiles = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.cursorrules',
  '.cursorignore',
  '.cursorindexingignore',
] as const
const nestedAgentInstructionFiles = ['docs/AGENTS.md'] as const

enum ImportEntryKind {
  Directory = 'directory',
  File = 'file',
}

enum ImportTargetPolicy {
  Absent = 'absent',
  DefaultConfiguration = 'defaultConfiguration',
  DefaultScripts = 'defaultScripts',
  EmptyFile = 'emptyFile',
}

interface ImportEntry {
  readonly content?: string
  readonly kind: ImportEntryKind
  readonly policy: ImportTargetPolicy
  readonly relativePath: string
  readonly sourcePath?: string
  readonly targetPath: string
}

export class TaskTemplateImportService implements ITaskTemplateImportService {
  async importTemplate(sourceRoot: string, targetRoot: string): Promise<TaskConfiguration> {
    const source = resolve(sourceRoot)
    const target = resolve(targetRoot)
    if (source === target) {
      throw new UsageError('--scan source directory must differ from the target task directory.')
    }

    await this.assertDirectory(source, 'scan directory', 'scan-directory-invalid')

    const sourceConfigurationPath = resolve(source, configurationFileName)
    const targetConfigurationPath = resolve(target, configurationFileName)
    const content = await this.readSourceConfiguration(sourceConfigurationPath)
    const configuration = parseTaskConfiguration(target, targetConfigurationPath, content)
    const entries = await this.collectEntries(source, target, content)

    for (const entry of entries) {
      await this.assertTargetCanReceive(entry)
    }

    await this.importTransaction(target, entries)
    return configuration
  }

  private async collectEntries(
    source: string,
    target: string,
    configurationContent: string,
  ): Promise<readonly ImportEntry[]> {
    const entries: ImportEntry[] = [
      {
        content: configurationContent,
        kind: ImportEntryKind.File,
        policy: ImportTargetPolicy.DefaultConfiguration,
        relativePath: configurationFileName,
        targetPath: resolve(target, configurationFileName),
      },
    ]

    const sourceScriptsPath = resolve(source, scriptsDirectoryName)
    const hasSourceScripts = await this.pathExists(sourceScriptsPath)
    if (hasSourceScripts) {
      await this.assertArtifact(
        sourceScriptsPath,
        ImportEntryKind.Directory,
        'source scripts path',
        'scan-scripts-invalid',
      )
    }
    entries.push({
      kind: ImportEntryKind.Directory,
      policy: ImportTargetPolicy.DefaultScripts,
      relativePath: scriptsDirectoryName,
      ...(hasSourceScripts ? { sourcePath: sourceScriptsPath } : {}),
      targetPath: resolve(target, scriptsDirectoryName),
    })

    for (const relativePath of agentConfigurationDirectories) {
      await this.collectOptionalEntry(
        entries,
        source,
        target,
        relativePath,
        ImportEntryKind.Directory,
      )
    }
    for (const relativePath of agentConfigurationFiles) {
      await this.collectOptionalEntry(
        entries,
        source,
        target,
        relativePath,
        ImportEntryKind.File,
        relativePath === 'AGENTS.md' ? ImportTargetPolicy.EmptyFile : ImportTargetPolicy.Absent,
      )
    }
    for (const relativePath of nestedAgentInstructionFiles) {
      await this.collectOptionalEntry(
        entries,
        source,
        target,
        relativePath,
        ImportEntryKind.File,
        ImportTargetPolicy.EmptyFile,
      )
    }

    return entries
  }

  private async collectOptionalEntry(
    entries: ImportEntry[],
    source: string,
    target: string,
    relativePath: string,
    kind: ImportEntryKind,
    policy: ImportTargetPolicy = ImportTargetPolicy.Absent,
  ): Promise<void> {
    const sourcePath = resolve(source, relativePath)
    if (!(await this.pathExists(sourcePath))) return

    await this.assertArtifact(
      sourcePath,
      kind,
      `source agent configuration '${relativePath}'`,
      'scan-agent-configuration-invalid',
    )
    entries.push({
      kind,
      policy,
      relativePath,
      sourcePath,
      targetPath: resolve(target, relativePath),
    })
  }

  private async readSourceConfiguration(path: string): Promise<string> {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new GitsError(
        'scan-config-unavailable',
        `Cannot read source ${configurationFileName}: ${message}`,
      )
    }
  }

  private async assertTargetCanReceive(entry: ImportEntry): Promise<void> {
    if (!(await this.pathExists(entry.targetPath))) return

    switch (entry.policy) {
      case ImportTargetPolicy.DefaultConfiguration: {
        const content = await readFile(entry.targetPath, 'utf8')
        if (!isDefaultTaskConfigurationTemplate(content)) {
          throw new ConfigurationError(
            `${configurationFileName} already exists and is not the default placeholder; refusing to overwrite it.`,
          )
        }
        return
      }
      case ImportTargetPolicy.DefaultScripts:
        await this.assertDefaultScriptsDirectory(entry.targetPath)
        return
      case ImportTargetPolicy.EmptyFile: {
        const content = await readFile(entry.targetPath, 'utf8')
        if (content.length > 0) {
          throw new ConfigurationError(
            `Target ${entry.relativePath} is not empty; refusing to overwrite it.`,
          )
        }
        return
      }
      case ImportTargetPolicy.Absent:
        throw new ConfigurationError(
          `Target ${entry.relativePath} already exists; refusing to overwrite it.`,
        )
    }
  }

  private async assertDefaultScriptsDirectory(path: string): Promise<void> {
    await this.assertDirectory(path, 'target scripts path', 'target-scripts-invalid')
    const entries = await readdir(path, { withFileTypes: true })
    if (entries.length === 0) return

    if (
      entries.length === 1 &&
      entries[0]?.isFile() &&
      entries[0].name === 'AGENTS.md' &&
      (await readFile(resolve(path, 'AGENTS.md'), 'utf8')).length === 0
    ) {
      return
    }

    throw new ConfigurationError(
      'Target scripts directory contains files other than the default empty AGENTS.md; refusing to overwrite it.',
    )
  }

  private async importTransaction(target: string, entries: readonly ImportEntry[]): Promise<void> {
    const transactionPath = resolve(target, `.gits-import-${process.pid}-${Date.now()}`)
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
        if (!(await this.pathExists(entry.targetPath))) continue
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
      throw new GitsError('template-import-failed', `Cannot import task template: ${message}`)
    } finally {
      await rm(transactionPath, { force: true, recursive: true })
    }
  }

  private async stageEntry(stagedRoot: string, entry: ImportEntry): Promise<void> {
    const stagedPath = resolve(stagedRoot, entry.relativePath)
    await mkdir(dirname(stagedPath), { recursive: true })

    if (entry.content !== undefined) {
      await writeFile(stagedPath, entry.content, 'utf8')
      return
    }
    if (entry.sourcePath === undefined) {
      await mkdir(stagedPath)
      return
    }

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
    writtenEntries: readonly ImportEntry[],
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
      // Preserve the original import error; recovery may be inspected manually.
    }
  }

  private async assertArtifact(
    path: string,
    kind: ImportEntryKind,
    label: string,
    code: string,
  ): Promise<void> {
    try {
      const metadata = await lstat(path)
      const matches =
        metadata.isSymbolicLink() ||
        (kind === ImportEntryKind.Directory ? metadata.isDirectory() : metadata.isFile())
      if (!matches) {
        throw new GitsError(code, `${label} is not a ${kind}: ${path}`)
      }
    } catch (error) {
      if (error instanceof GitsError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new GitsError(code, `Cannot access ${label} ${path}: ${message}`)
    }
  }

  private async assertDirectory(path: string, label: string, code: string): Promise<void> {
    await this.assertArtifact(path, ImportEntryKind.Directory, label, code)
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
