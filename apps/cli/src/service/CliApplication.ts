import { Many } from '@wendellhu/redi'
import { Cli, z } from 'incur'

import { ICliCommand, type ICliApplication } from '../contract/index'

export class CliApplication implements ICliApplication {
  constructor(@Many(ICliCommand) private readonly commands: ICliCommand[]) {}

  async run(argv: readonly string[]): Promise<void> {
    const cli = Cli.create('gits', {
      description: 'Manage a task branch set across Git repositories.',
      globalAlias: { cwd: 'C' },
      globals: z.object({
        cwd: z.string().optional().describe('Run as if started in this directory'),
      }),
      update: false,
      version: '0.1.0',
    })
    for (const command of this.commands) command.register(cli)
    await cli.serve([...argv])
  }
}
