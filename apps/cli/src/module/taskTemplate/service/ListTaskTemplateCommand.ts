import {
  IListTaskTemplateService,
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

export class ListTaskTemplateCommand implements ITaskTemplateSubcommand {
  constructor(
    @Inject(IListTaskTemplateService)
    private readonly service: IListTaskTemplateService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService
  ) {}

  register(cli: CliInstance): void {
    cli.command('list', {
      description: 'List built-in and machine-local task templates.',
      output: taskTemplateCommandOutputSchema,
      options: z.object({
        wide: z.boolean().default(false).describe('Show full template details'),
      }),
      run: async (context) => {
        return this.output.runTaskTemplate(
          context,
          TaskTemplateCommandName.List,
          async () => this.service.execute({ wide: context.options.wide }),
          {
            nextCommands: [
              {
                command: 'template add',
                description: 'Save a task directory as a template',
              },
            ],
            wide: context.options.wide,
          }
        )
      },
    })
  }
}
