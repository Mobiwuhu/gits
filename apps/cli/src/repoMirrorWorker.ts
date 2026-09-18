#!/usr/bin/env node

import { createContainer, schedulerWorkerSource } from './bootstrap/index'
import { ICliApplication } from './contract/index'

const container = createContainer(schedulerWorkerSource(import.meta.url))
try {
  await container.get(ICliApplication).run(process.argv.slice(2))
} finally {
  container.dispose()
}
