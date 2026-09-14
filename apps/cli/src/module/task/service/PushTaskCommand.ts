import { IPushTaskService } from '@gits/core'
import { Inject } from '@wendellhu/redi'
import { Cli, z } from 'incur'

import {
  ICliOutputService,
  ICliRuntimeService,
  type CliContext,
  type CliInstance,
  type ICliCommand,
} from '../../../contract/index'

export class PushTaskCommand implements ICliCommand {
  constructor(
    @Inject(IPushTaskService) private readonly service: IPushTaskService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService,
    @Inject(ICliRuntimeService) private readonly runtime: ICliRuntimeService,
  ) {}

  register(cli: CliInstance): void {
    cli.command(
      'push',
      Cli.command({
        args: z.object({ repos: z.array(z.string()).default([]) }),
        description: 'Push task branches to origin with upstream tracking.',
        options: z.object({
          all: z.boolean().default(false).describe('Push every configured repository'),
          dryRun: z.boolean().default(false).describe('Ask Git to simulate the push'),
        }),
        run: async (rawContext) => {
          const context = rawContext as CliContext & {
            readonly args: { readonly repos: readonly string[] }
            readonly options: { readonly all: boolean; readonly dryRun: boolean }
          }
          return this.output.runCommand(
            context,
            'push',
            async (signal) =>
              this.service.execute({
                all: context.options.all,
                dryRun: context.options.dryRun,
                interactive: !context.agent,
                renderProgress: !context.agent,
                repositories: context.args.repos,
                root: await this.runtime.taskRoot(context),
                signal,
              }),
            [{ command: 'status', description: 'Inspect repository state after pushing' }],
          )
        },
      }),
    )
  }
}
