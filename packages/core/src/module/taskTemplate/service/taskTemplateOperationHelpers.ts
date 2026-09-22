import { resolve } from 'node:path'

import {
  GitsError,
  TaskTemplateKind,
  TaskTemplateBusyError,
  TaskTemplateState,
} from '../../../contract/index'
import type {
  GitsPaths,
  TaskTemplateAction,
  TaskTemplateCapture,
  TaskTemplateLockRelease,
  TaskTemplateView,
} from '../../../contract/index'
import { canonicalizePath, isPathInside } from '../../../util/index'
import { assertSeparatePaths } from './taskTemplateHelpers'

export async function assertTemplateSourceSafety(
  sourceRoot: string,
  paths: GitsPaths
): Promise<string> {
  const source = await canonicalizePath(resolve(sourceRoot))
  const home = await canonicalizePath(paths.home)
  const templates = await canonicalizePath(paths.templates)
  if (isPathInside(home, source) || isPathInside(source, home)) {
    throw new GitsError(
      'template-source-overlap',
      `Template source must not overlap GITS_HOME: ${source}`
    )
  }
  assertSeparatePaths(
    source,
    templates,
    `Template source must not overlap template storage: ${source}`
  )
  return source
}

export function captureView(
  capture: TaskTemplateCapture,
  action: TaskTemplateAction,
  path: string | null,
  state: TaskTemplateView['state'] = TaskTemplateState.Ready
): TaskTemplateView {
  return {
    action,
    byteCount: capture.manifest.content.byteCount,
    createdAt: capture.manifest.createdAt,
    createdWith: capture.manifest.createdWith,
    digest: capture.manifest.content.digest,
    error: null,
    fileCount: capture.manifest.content.fileCount,
    kind: TaskTemplateKind.Local,
    name: capture.manifest.name,
    path,
    state,
    updatedAt: capture.manifest.updatedAt,
  }
}

export function requireTemplateLock(
  release: TaskTemplateLockRelease | null,
  names: readonly string[]
): TaskTemplateLockRelease {
  if (release === null) {
    throw new TaskTemplateBusyError(names)
  }
  return release
}
