import { defineConfig } from 'tsdown'

export default defineConfig({
  banner: '/* gits-repo-mirror-worker-bundle:v1 */',
  clean: false,
  deps: {
    alwaysBundle: () => true,
    onlyBundle: false,
  },
  dts: false,
  entry: { 'repo-mirror-worker': 'src/repoMirrorWorker.ts' },
  fixedExtension: true,
  format: ['esm'],
  inputOptions: { resolve: { mainFields: ['module', 'main'] } },
  outputOptions: { codeSplitting: false },
  platform: 'node',
  sourcemap: false,
  target: 'node22',
})
