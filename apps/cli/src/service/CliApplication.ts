import { Many } from '@wendellhu/redi'
import { Cli } from 'incur'

import cliPackage from '../../package.json' with { type: 'json' }
import { cliGlobalsSchema, ICliCommand } from '../contract/index'
import type { ICliApplication } from '../contract/index'

export class CliApplication implements ICliApplication {
  constructor(@Many(ICliCommand) private readonly commands: ICliCommand[]) {}

  async run(argv: readonly string[]): Promise<void> {
    const cli = Cli.create('gits', {
      description: 'Manage a task branch set across Git repositories.',
      globalAlias: { cwd: 'C' },
      globals: cliGlobalsSchema,
      update: false,
      version: cliPackage.version,
    })
    for (const command of this.commands) {
      command.register(cli)
    }
    await cli.serve([...argv])
  }
}
