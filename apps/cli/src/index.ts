#!/usr/bin/env node

import { createContainer } from './bootstrap/index'
import { ICliApplication } from './contract/index'

const container = createContainer()
try {
  await container.get(ICliApplication).run(process.argv.slice(2))
} finally {
  container.dispose()
}
