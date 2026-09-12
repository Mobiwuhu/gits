#!/usr/bin/env node

import { Cli, z } from 'incur'

const cli = Cli.create('gits', {
  description: 'Manage a task branch set across Git repositories.',
  globalAlias: { cwd: 'C' },
  globals: z.object({ cwd: z.string().optional().describe('Run as if started in this directory') }),
  update: false,
  version: '0.1.0',
})

await cli.fs(new URL('./presentation/cli/routes/', import.meta.url)).serve()
