import { defineConfig } from 'tsdown'

export default defineConfig({
  banner: '/* gits-repo-mirror-worker-bundle:v1 */',
  clean: true,
  copy: ['../../packages/core/templates'],
  deps: {
    alwaysBundle: () => true,
    onlyBundle: false,
  },
  dts: false,
  entry: ['src/index.ts'],
  fixedExtension: false,
  format: ['esm'],
  inputOptions: {
    resolve: {
      conditionNames: ['@usegit/source', 'import', 'node', 'default'],
      mainFields: ['module', 'main'],
    },
  },
  outputOptions: { codeSplitting: false },
  platform: 'node',
  sourcemap: false,
  target: 'node22',
})
