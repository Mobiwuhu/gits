import {
  builtInTaskTemplateName,
  BuiltInTaskTemplateReadonlyError,
  GitsError,
  TaskTemplateNameError,
} from '../../../contract/index'
import type {
  CommandError,
  MaterializationEntry,
  TaskDirectoryEntry,
} from '../../../contract/index'
import { errorMessage, isPathInside } from '../../../util/index'

const taskTemplateNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u

export function assertTaskTemplateName(
  name: string,
  options: Readonly<{ allowDefault?: boolean }> = {}
): void {
  if (!taskTemplateNamePattern.test(name)) {
    throw new TaskTemplateNameError(name)
  }
  if (name === builtInTaskTemplateName && options.allowDefault !== true) {
    throw new BuiltInTaskTemplateReadonlyError()
  }
}

export function commandError(code: string, message: string): CommandError {
  return { code, message }
}

export function errorCommand(error: unknown): CommandError {
  return error instanceof GitsError
    ? commandError(error.code, error.message)
    : commandError('template-operation-failed', errorMessage(error))
}

export function assertSeparatePaths(
  source: string,
  target: string,
  message: string
): void {
  if (isPathInside(source, target) || isPathInside(target, source)) {
    throw new GitsError('template-source-overlap', message, 2)
  }
}

export function toMaterializationEntry(
  entry: TaskDirectoryEntry
): MaterializationEntry {
  return {
    kind: entry.kind,
    mode: entry.mode,
    relativePath: entry.relativePath,
    sourcePath: entry.sourcePath,
    ...(entry.linkTarget === undefined ? {} : { linkTarget: entry.linkTarget }),
  }
}
