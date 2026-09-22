import { resolve } from 'node:path'

import { IAddTaskTemplateService, TaskTemplateCommandName } from '@usegits/core'
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

export class AddTaskTemplateCommand implements ITaskTemplateSubcommand {
  constructor(
    @Inject(IAddTaskTemplateService)
    private readonly service: IAddTaskTemplateService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService,
    @Inject(ICliRuntimeService) private readonly runtime: ICliRuntimeService
  ) {}

  register(cli: CliInstance): void {
    cli.command('add', {
      args: z.object({
        name: z.string().describe('Template name'),
        sourceDirectory: z
          .string()
          .describe('Complete task scaffold directory'),
      }),
      description: 'Save a complete task directory as a named template.',
      output: taskTemplateCommandOutputSchema,
      options: z.object({
        dryRun: z
          .boolean()
          .default(false)
          .describe('Validate and preview without saving the template'),
      }),
      run: async (context) => {
        return this.output.runTaskTemplate(
          context,
          TaskTemplateCommandName.Add,
          async (signal) => {
            const base = await this.runtime.commandRoot(context)
            return this.service.execute({
              dryRun: context.options.dryRun,
              name: context.args.name,
              signal,
              sourceRoot: resolve(base, context.args.sourceDirectory),
            })
          },
          {
            nextCommands: [
              {
                command: 'template list',
                description: 'List available task templates',
              },
            ],
          }
        )
      },
    })
  }
}
