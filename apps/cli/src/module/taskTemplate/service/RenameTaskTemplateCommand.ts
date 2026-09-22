import {
  IRenameTaskTemplateService,
  TaskTemplateCommandName,
} from '@usegits/core'
import { Inject } from '@wendellhu/redi'
import { z } from 'incur'

import {
  ICliOutputService,
  taskTemplateCommandOutputSchema,
} from '../../../contract/index'
import type {
  CliInstance,
  ITaskTemplateSubcommand,
} from '../../../contract/index'

export class RenameTaskTemplateCommand implements ITaskTemplateSubcommand {
  constructor(
    @Inject(IRenameTaskTemplateService)
    private readonly service: IRenameTaskTemplateService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService
  ) {}

  register(cli: CliInstance): void {
    cli.command('rename', {
      args: z.object({
        name: z.string().describe('Current template name'),
        newName: z.string().describe('New template name'),
      }),
      description: 'Rename a machine-local task template.',
      output: taskTemplateCommandOutputSchema,
      run: async (context) => {
        return this.output.runTaskTemplate(
          context,
          TaskTemplateCommandName.Rename,
          async (signal) =>
            this.service.execute({
              name: context.args.name,
              newName: context.args.newName,
              signal,
            })
        )
      },
    })
  }
}
