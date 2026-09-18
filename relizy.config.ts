import { defineConfig } from 'relizy'

export default defineConfig({
  changelog: {
    formatCmd: 'pnpm format',
  },
  hooks: {
    'before:release': 'pnpm check',
  },
  monorepo: {
    includePrivates: true,
    packages: ['.', 'apps/*', 'packages/*'],
    versionMode: 'unified',
  },
  projectName: 'gits',
  release: {
    prComment: false,
    publish: false,
    social: false,
  },
})
