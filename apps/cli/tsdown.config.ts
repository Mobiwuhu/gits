import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  deps: {
    neverBundle: true,
  },
  dts: false,
  entry: ['src/index.ts'],
  fixedExtension: false,
  format: ['esm'],
  platform: 'node',
  sourcemap: true,
  target: 'node22',
})
