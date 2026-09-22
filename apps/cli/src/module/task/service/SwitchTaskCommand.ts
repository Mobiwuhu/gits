import { ISwitchTaskService } from '@usegits/core'
import { Inject } from '@wendellhu/redi'
import { z } from 'incur'

import {
  commandOutputSchema,
  ICliOutputService,
  ICliRuntimeService,
} from '../../../contract/index'
import type { CliInstance, ICliCommand } from '../../../contract/index'

export class SwitchTaskCommand implements ICliCommand {
  constructor(
    @Inject(ISwitchTaskService) private readonly service: ISwitchTaskService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService,
    @Inject(ICliRuntimeService) private readonly runtime: ICliRuntimeService
  ) {}

  register(cli: CliInstance): void {
    cli.command('switch', {
      alias: { jobs: 'j' },
      args: z.object({ repos: z.array(z.string()).default([]) }),
      description: 'Switch repositories to their configured task branches.',
      output: commandOutputSchema,
      options: z.object({
        jobs: z.string().optional().describe('Maximum concurrent fetch jobs'),
        stash: z
          .boolean()
          .default(false)
          .describe('Stash dirty worktrees before switching'),
      }),
      run: async (context) => {
        return this.output.runCommand(
          context,
          'switch',
          async (signal) => {
            const jobs = this.runtime.parseJobs(context.options.jobs)
            return this.service.execute({
              interactive: !context.agent,
              renderProgress: !context.agent,
              repositories: context.args.repos,
              root: await this.runtime.taskRoot(context),
              signal,
              stash: context.options.stash,
              ...(jobs === undefined ? {} : { jobs }),
            })
          },
          [
            {
              command: 'status',
              description: 'Inspect switched repository state',
            },
          ]
        )
      },
    })
  }
}
