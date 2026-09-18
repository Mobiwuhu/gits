import { basename, dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { gitsManagedArtifactRegistry } from '@gits/core'

export function schedulerWorkerSource(moduleUrl: string): string {
  const modulePath = fileURLToPath(moduleUrl)
  const worker = gitsManagedArtifactRegistry.schedulerWorker
  const moduleName = basename(modulePath)
  if (
    moduleName === worker.fileName ||
    moduleName === worker.packagedFileName
  ) {
    return modulePath
  }
  const directory = dirname(modulePath)
  return extname(modulePath) === '.ts'
    ? resolve(directory, '../dist', worker.packagedFileName)
    : resolve(directory, worker.packagedFileName)
}
