import { defineConfig } from 'tsdown'

import { writeCoreDistPackage } from '../../scripts/writeCoreDistPackage'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  fixedExtension: false,
  clean: true,
  sourcemap: true,
  dts: {
    sourcemap: true,
  },
  deps: {
    neverBundle: true,
  },
  hooks: {
    'build:done': async () => {
      await writeCoreDistPackage(import.meta.dirname)
    },
  },
})
