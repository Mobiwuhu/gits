import { IInitializeTaskService } from '@gits/core'
import { Inject } from '@wendellhu/redi'
import { Cli, z } from 'incur'

import {
  ICliOutputService,
  ICliRuntimeService,
  type CliContext,
  type CliInstance,
  type ICliCommand,
} from '../../../contract/index'

export class InitializeTaskCommand implements ICliCommand {
  constructor(
    @Inject(IInitializeTaskService) private readonly service: IInitializeTaskService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService,
    @Inject(ICliRuntimeService) private readonly runtime: ICliRuntimeService,
  ) {}

  register(cli: CliInstance): void {
    cli.command(
      'init',
      Cli.command({
        description: 'Create or complete a task branch set workspace.',
        options: z.object({
          scan: z
            .string()
            .optional()
            .describe('Source task directory; imports everything except repos'),
        }),
        run: async (rawContext) => {
          const context = rawContext as CliContext & {
            readonly options: { readonly scan?: string }
          }
          return this.output.runCommand(
            context,
            'init',
            async (signal) =>
              this.service.execute({
                root: await this.runtime.commandRoot(context),
                signal,
                ...(context.options.scan === undefined ? {} : { scanPath: context.options.scan }),
              }),
            [{ command: 'install', description: 'Prepare configured repositories' }],
          )
        },
      }),
    )
  }
}
