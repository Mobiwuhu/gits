import { defineConfig } from 'relizy'

export default defineConfig({
  changelog: {
    formatCmd: 'pnpm format',
  },
  hooks: {
    'before:publish': 'pnpm check',
  },
  monorepo: {
    includePrivates: true,
    packages: ['.', 'apps/*', 'packages/*'],
    versionMode: 'unified',
  },
  projectName: 'gits',
  publish: {
    access: 'public',
    packageManager: 'pnpm',
  },
  release: {
    prComment: false,
    social: false,
  },
})
