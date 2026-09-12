import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { TaskTemplateImporter } from '../../application/ports/task-template-importer.js'
import { ConfigurationError, GitsError, UsageError } from '../../domain/task/errors.js'
import type { TaskConfiguration } from '../../domain/task/model.js'
import {
  isDefaultTaskConfigurationTemplate,
  parseTaskConfiguration,
} from '../config/jsonc-task-configuration-store.js'

const configurationFileName = 'task.config.jsonc'
const scriptsDirectoryName = 'scripts'

export class NodeTaskTemplateImporter implements TaskTemplateImporter {
  async importTemplate(sourceRoot: string, targetRoot: string): Promise<TaskConfiguration> {
    const source = resolve(sourceRoot)
    const target = resolve(targetRoot)
    if (source === target) {
      throw new UsageError('--scan source directory must differ from the target task directory.')
    }

    await assertDirectory(source, 'scan directory', 'scan-directory-invalid')

    const sourceConfigurationPath = resolve(source, configurationFileName)
    const targetConfigurationPath = resolve(target, configurationFileName)
    const sourceScriptsPath = resolve(source, scriptsDirectoryName)
    const targetScriptsPath = resolve(target, scriptsDirectoryName)
    const content = await readSourceConfiguration(sourceConfigurationPath)
    const configuration = parseTaskConfiguration(target, targetConfigurationPath, content)
    const hasSourceScripts = await assertSourceScripts(sourceScriptsPath)
    await assertTargetCanReceive(targetConfigurationPath, targetScriptsPath)

    await importTransaction({
      content,
      hasSourceScripts,
      sourceScriptsPath,
      target,
      targetConfigurationPath,
      targetScriptsPath,
    })
    return configuration
  }
}

async function readSourceConfiguration(path: string): Promise<string> {
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

async function assertSourceScripts(path: string): Promise<boolean> {
  if (!(await pathExists(path))) return false
  await assertDirectory(path, 'source scripts path', 'scan-scripts-invalid')
  return true
}

async function assertTargetCanReceive(
  configurationPath: string,
  scriptsPath: string,
): Promise<void> {
  if (await pathExists(configurationPath)) {
    const content = await readFile(configurationPath, 'utf8')
    if (!isDefaultTaskConfigurationTemplate(content)) {
      throw new ConfigurationError(
        `${configurationFileName} already exists and is not the default placeholder; refusing to overwrite it.`,
      )
    }
  }

  if (!(await pathExists(scriptsPath))) return
  await assertDirectory(scriptsPath, 'target scripts path', 'target-scripts-invalid')
  if ((await readdir(scriptsPath)).length > 0) {
    throw new ConfigurationError('Target scripts directory is not empty; refusing to overwrite it.')
  }
}

async function importTransaction(input: {
  readonly content: string
  readonly hasSourceScripts: boolean
  readonly sourceScriptsPath: string
  readonly target: string
  readonly targetConfigurationPath: string
  readonly targetScriptsPath: string
}): Promise<void> {
  const transactionPath = resolve(input.target, `.gits-import-${process.pid}-${Date.now()}`)
  const stagedConfigurationPath = resolve(transactionPath, configurationFileName)
  const stagedScriptsPath = resolve(transactionPath, scriptsDirectoryName)
  const backupConfigurationPath = resolve(transactionPath, 'previous-config')
  const backupScriptsPath = resolve(transactionPath, 'previous-scripts')
  let movedConfiguration = false
  let movedScripts = false
  let wroteConfiguration = false
  let wroteScripts = false

  try {
    await mkdir(transactionPath, { recursive: true })
    await writeFile(stagedConfigurationPath, input.content, 'utf8')
    if (input.hasSourceScripts) {
      await cp(input.sourceScriptsPath, stagedScriptsPath, {
        dereference: false,
        errorOnExist: true,
        force: false,
        recursive: true,
      })
    } else {
      await mkdir(stagedScriptsPath)
    }

    if (await pathExists(input.targetConfigurationPath)) {
      await rename(input.targetConfigurationPath, backupConfigurationPath)
      movedConfiguration = true
    }
    if (await pathExists(input.targetScriptsPath)) {
      await rename(input.targetScriptsPath, backupScriptsPath)
      movedScripts = true
    }

    await rename(stagedConfigurationPath, input.targetConfigurationPath)
    wroteConfiguration = true
    await rename(stagedScriptsPath, input.targetScriptsPath)
    wroteScripts = true
  } catch (error) {
    await rollback({
      backupConfigurationPath,
      backupScriptsPath,
      movedConfiguration,
      movedScripts,
      targetConfigurationPath: input.targetConfigurationPath,
      targetScriptsPath: input.targetScriptsPath,
      wroteConfiguration,
      wroteScripts,
    })
    const message = error instanceof Error ? error.message : String(error)
    throw new GitsError('template-import-failed', `Cannot import task template: ${message}`)
  } finally {
    await rm(transactionPath, { force: true, recursive: true })
  }
}

async function rollback(input: {
  readonly backupConfigurationPath: string
  readonly backupScriptsPath: string
  readonly movedConfiguration: boolean
  readonly movedScripts: boolean
  readonly targetConfigurationPath: string
  readonly targetScriptsPath: string
  readonly wroteConfiguration: boolean
  readonly wroteScripts: boolean
}): Promise<void> {
  try {
    if (input.wroteConfiguration) {
      await rm(input.targetConfigurationPath, { force: true })
    }
    if (input.wroteScripts) {
      await rm(input.targetScriptsPath, { force: true, recursive: true })
    }
    if (input.movedConfiguration) {
      await rename(input.backupConfigurationPath, input.targetConfigurationPath)
    }
    if (input.movedScripts) {
      await rename(input.backupScriptsPath, input.targetScriptsPath)
    }
  } catch {
    // Preserve the original import error; recovery may be inspected manually.
  }
}

async function assertDirectory(path: string, label: string, code: string): Promise<void> {
  try {
    const metadata = await lstat(path)
    if (!metadata.isDirectory()) {
      throw new GitsError(code, `${label} is not a directory: ${path}`)
    }
  } catch (error) {
    if (error instanceof GitsError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new GitsError(code, `Cannot access ${label} ${path}: ${message}`)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}
