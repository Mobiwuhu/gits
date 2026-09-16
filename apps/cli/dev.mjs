#!/usr/bin/env node

import { fileURLToPath } from 'node:url'

import { register } from 'tsx/esm/api'

register({
  tsconfig: fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url)),
})

await import('./src/index.ts')
