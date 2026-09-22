import { Many } from '@wendellhu/redi'
import { Cli } from 'incur'

import {
  cliGlobalsSchema,
  ITaskTemplateSubcommand,
} from '../../../contract/index'
import type { CliInstance, ICliCommand } from '../../../contract/index'

export class TaskTemplateCommand implements ICliCommand {
  constructor(
    @Many(ITaskTemplateSubcommand)
    private readonly subcommands: ITaskTemplateSubcommand[]
  ) {}

  register(cli: CliInstance): void {
    const templates = Cli.create('template', {
      description: 'Manage machine-local task templates.',
      globals: cliGlobalsSchema,
    })
    for (const subcommand of this.subcommands) {
      subcommand.register(templates)
    }
    cli.command(templates)
  }
}
