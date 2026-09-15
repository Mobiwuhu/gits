import { defineConfig } from 'tsdown'

import { writeCoreDistPackage } from '../../scripts/writeCoreDistPackage'

export default defineConfig({
  clean: true,
  deps: {
    neverBundle: true,
  },
  dts: {
    sourcemap: true,
  },
  entry: ['src/index.ts'],
  fixedExtension: false,
  format: ['esm'],
  hooks: {
    'build:done': async () => {
      await writeCoreDistPackage(import.meta.dirname)
    },
  },
  platform: 'node',
  sourcemap: true,
  target: 'node22',
})
