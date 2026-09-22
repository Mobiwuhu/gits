import {
  IRemoveTaskTemplateService,
  TaskTemplateCommandName,
} from '@usegits/core'
import { Inject } from '@wendellhu/redi'
import { z } from 'incur'

import {
  ICliConfirmationService,
  ICliOutputService,
  taskTemplateCommandOutputSchema,
} from '../../../contract/index'
import type {
  CliInstance,
  ITaskTemplateSubcommand,
} from '../../../contract/index'

export class RemoveTaskTemplateCommand implements ITaskTemplateSubcommand {
  constructor(
    @Inject(IRemoveTaskTemplateService)
    private readonly service: IRemoveTaskTemplateService,
    @Inject(ICliConfirmationService)
    private readonly confirmation: ICliConfirmationService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService
  ) {}

  register(cli: CliInstance): void {
    cli.command('remove', {
      args: z.object({ name: z.string().describe('Template name') }),
      description: 'Move a task template to trash or permanently delete it.',
      destructive: true,
      hint: 'Templates are recoverable unless --purge is supplied.',
      output: taskTemplateCommandOutputSchema,
      options: z.object({
        purge: z
          .boolean()
          .default(false)
          .describe('Delete permanently instead of moving to trash'),
        yes: z
          .boolean()
          .default(false)
          .describe('Confirm removal without prompting'),
      }),
      run: async (context) => {
        return this.output.runTaskTemplate(
          context,
          TaskTemplateCommandName.Remove,
          async (signal) => {
            const confirmed = await this.confirmation.confirm(
              context,
              context.options.yes,
              context.options.purge
                ? `Permanently delete task template ${context.args.name}?`
                : `Move task template ${context.args.name} to trash?`
            )
            return this.service.execute({
              confirmed,
              name: context.args.name,
              purge: context.options.purge,
              signal,
            })
          }
        )
      },
    })
  }
}
