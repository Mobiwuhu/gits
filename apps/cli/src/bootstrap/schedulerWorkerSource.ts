import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { gitsManagedArtifactRegistry } from '@usegit/core'

export function schedulerWorkerSource(moduleUrl: string): string {
  const modulePath = fileURLToPath(moduleUrl)
  if (extname(modulePath) !== '.ts') {
    return modulePath
  }
  return resolve(
    dirname(modulePath),
    '../dist',
    gitsManagedArtifactRegistry.schedulerWorker.packagedFileName
  )
}
