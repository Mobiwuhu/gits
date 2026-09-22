import { resolve } from 'node:path'

import { IInitializeTaskService } from '@usegits/core'
import { Inject } from '@wendellhu/redi'
import { z } from 'incur'

import {
  ICliOutputService,
  ICliRuntimeService,
  initializeTaskOutputSchema,
} from '../../../contract/index'
import type { CliInstance, ICliCommand } from '../../../contract/index'

export class InitializeTaskCommand implements ICliCommand {
  constructor(
    @Inject(IInitializeTaskService)
    private readonly service: IInitializeTaskService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService,
    @Inject(ICliRuntimeService) private readonly runtime: ICliRuntimeService
  ) {}

  register(cli: CliInstance): void {
    cli.command('init', {
      args: z.object({
        directory: z
          .string()
          .optional()
          .describe('Task directory to create or complete'),
      }),
      description: 'Create or complete a task branch set workspace.',
      output: initializeTaskOutputSchema,
      options: z
        .object({
          dryRun: z
            .boolean()
            .default(false)
            .describe('Preview without changing the target directory'),
          from: z
            .string()
            .optional()
            .describe('Import once from an existing task directory'),
          template: z
            .string()
            .optional()
            .describe('Create from a named machine-local template'),
        })
        .refine(
          ({ from, template }) => from === undefined || template === undefined,
          {
            message: '--template and --from cannot be combined.',
          }
        ),
      run: async (context) => {
        return this.output.runCommand(
          context,
          'init',
          async (signal) => {
            const base = await this.runtime.commandRoot(context)
            return this.service.execute({
              dryRun: context.options.dryRun,
              root: resolve(base, context.args.directory ?? '.'),
              signal,
              ...(context.options.from === undefined
                ? {}
                : { fromPath: resolve(base, context.options.from) }),
              ...(context.options.template === undefined
                ? {}
                : { template: context.options.template }),
            })
          },
          [
            {
              command: 'install',
              description: 'Prepare configured repositories',
            },
          ]
        )
      },
    })
  }
}
