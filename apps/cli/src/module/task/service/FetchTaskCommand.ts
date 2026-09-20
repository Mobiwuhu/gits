import { IFetchTaskService } from '@usegit/core'
import { Inject } from '@wendellhu/redi'
import { Cli, z } from 'incur'

import { ICliOutputService, ICliRuntimeService } from '../../../contract/index'
import type {
  CliContext,
  CliInstance,
  ICliCommand,
} from '../../../contract/index'

export class FetchTaskCommand implements ICliCommand {
  constructor(
    @Inject(IFetchTaskService) private readonly service: IFetchTaskService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService,
    @Inject(ICliRuntimeService) private readonly runtime: ICliRuntimeService
  ) {}

  register(cli: CliInstance): void {
    cli.command(
      'fetch',
      Cli.command({
        alias: { jobs: 'j' },
        args: z.object({ repos: z.array(z.string()).default([]) }),
        description:
          'Fetch origin and prune remote-tracking refs for repositories.',
        options: z.object({
          jobs: z
            .string()
            .optional()
            .describe('Maximum concurrent network jobs'),
        }),
        run: async (rawContext) => {
          const context = rawContext as CliContext & {
            readonly args: { readonly repos: readonly string[] }
            readonly options: { readonly jobs?: string }
          }
          return this.output.runCommand(
            context,
            'fetch',
            async (signal) => {
              const jobs = this.runtime.parseJobs(context.options.jobs)
              return this.service.execute({
                interactive: !context.agent,
                renderProgress: !context.agent,
                repositories: context.args.repos,
                root: await this.runtime.taskRoot(context),
                signal,
                ...(jobs === undefined ? {} : { jobs }),
              })
            },
            [
              {
                command: 'status',
                description: 'Inspect refreshed repository state',
              },
            ]
          )
        },
      })
    )
  }
}
