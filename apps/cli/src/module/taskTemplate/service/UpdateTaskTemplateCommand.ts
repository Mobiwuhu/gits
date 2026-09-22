import { resolve } from 'node:path'

import {
  IUpdateTaskTemplateService,
  TaskTemplateCommandName,
} from '@usegits/core'
import { Inject } from '@wendellhu/redi'
import { z } from 'incur'

import {
  ICliOutputService,
  ICliRuntimeService,
  taskTemplateCommandOutputSchema,
} from '../../../contract/index'
import type {
  CliInstance,
  ITaskTemplateSubcommand,
} from '../../../contract/index'

export class UpdateTaskTemplateCommand implements ITaskTemplateSubcommand {
  constructor(
    @Inject(IUpdateTaskTemplateService)
    private readonly service: IUpdateTaskTemplateService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService,
    @Inject(ICliRuntimeService) private readonly runtime: ICliRuntimeService
  ) {}

  register(cli: CliInstance): void {
    cli.command('update', {
      args: z.object({
        name: z.string().describe('Template name'),
        sourceDirectory: z
          .string()
          .describe('Complete task scaffold directory'),
      }),
      description: 'Replace a named template with a validated snapshot.',
      output: taskTemplateCommandOutputSchema,
      options: z.object({
        dryRun: z
          .boolean()
          .default(false)
          .describe('Validate and preview without updating the template'),
      }),
      run: async (context) => {
        return this.output.runTaskTemplate(
          context,
          TaskTemplateCommandName.Update,
          async (signal) => {
            const base = await this.runtime.commandRoot(context)
            return this.service.execute({
              dryRun: context.options.dryRun,
              name: context.args.name,
              signal,
              sourceRoot: resolve(base, context.args.sourceDirectory),
            })
          }
        )
      },
    })
  }
}
