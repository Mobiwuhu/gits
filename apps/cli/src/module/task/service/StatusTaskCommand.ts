import { IStatusTaskService } from '@usegits/core'
import { Inject } from '@wendellhu/redi'
import { z } from 'incur'

import {
  commandOutputSchema,
  ICliOutputService,
  ICliRuntimeService,
} from '../../../contract/index'
import type { CliInstance, ICliCommand } from '../../../contract/index'

export class StatusTaskCommand implements ICliCommand {
  constructor(
    @Inject(IStatusTaskService) private readonly service: IStatusTaskService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService,
    @Inject(ICliRuntimeService) private readonly runtime: ICliRuntimeService
  ) {}

  register(cli: CliInstance): void {
    cli.command('status', {
      args: z.object({ repos: z.array(z.string()).default([]) }),
      description: 'Show aggregate Git state for task repositories.',
      output: commandOutputSchema,
      run: async (context) =>
        this.output.runCommand(
          context,
          'status',
          async (signal) =>
            this.service.execute({
              repositories: context.args.repos,
              root: await this.runtime.taskRoot(context),
              signal,
            }),
          [
            { command: 'fetch', description: 'Refresh remote-tracking refs' },
            {
              command: 'switch',
              description: 'Switch repositories to task branches',
            },
          ]
        ),
    })
  }
}
