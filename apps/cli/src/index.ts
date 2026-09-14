#!/usr/bin/env node

import { ICliApplication } from './contract/index'
import { createContainer } from './bootstrap/index'

const container = createContainer()
try {
  await container.get(ICliApplication).run(process.argv.slice(2))
} finally {
  container.dispose()
}
