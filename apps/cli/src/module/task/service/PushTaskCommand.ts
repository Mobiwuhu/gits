import { IPushTaskService } from '@usegits/core'
import { Inject } from '@wendellhu/redi'
import { z } from 'incur'

import {
  commandOutputSchema,
  ICliOutputService,
  ICliRuntimeService,
} from '../../../contract/index'
import type { CliInstance, ICliCommand } from '../../../contract/index'

export class PushTaskCommand implements ICliCommand {
  constructor(
    @Inject(IPushTaskService) private readonly service: IPushTaskService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService,
    @Inject(ICliRuntimeService) private readonly runtime: ICliRuntimeService
  ) {}

  register(cli: CliInstance): void {
    cli.command('push', {
      args: z.object({ repos: z.array(z.string()).default([]) }),
      description: 'Push task branches to origin with upstream tracking.',
      output: commandOutputSchema,
      options: z.object({
        all: z
          .boolean()
          .default(false)
          .describe('Push every configured repository'),
        dryRun: z
          .boolean()
          .default(false)
          .describe('Ask Git to simulate the push'),
      }),
      run: async (context) => {
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
          [
            {
              command: 'status',
              description: 'Inspect repository state after pushing',
            },
          ]
        )
      },
    })
  }
}
