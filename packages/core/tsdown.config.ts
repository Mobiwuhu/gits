import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  copy: ['templates'],
  deps: {
    neverBundle: true,
  },
  dts: {
    sourcemap: true,
  },
  entry: ['src/index.ts'],
  fixedExtension: false,
  format: ['esm'],
  platform: 'node',
  sourcemap: true,
  target: 'node22',
})
