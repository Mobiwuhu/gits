import {
  IFetchRepoMirrorService,
  RepoMirrorInvocationSource,
} from '@usegits/core'
import { Inject } from '@wendellhu/redi'
import { z } from 'incur'

import {
  ICliOutputService,
  repoMirrorCommandOutputSchema,
} from '../../../contract/index'
import type {
  CliInstance,
  IRepoMirrorSubcommand,
} from '../../../contract/index'

export class FetchRepoMirrorCommand implements IRepoMirrorSubcommand {
  constructor(
    @Inject(IFetchRepoMirrorService)
    private readonly service: IFetchRepoMirrorService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService
  ) {}

  register(cli: CliInstance): void {
    cli.command('fetch', {
      alias: { jobs: 'j' },
      args: z.object({ names: z.array(z.string()).default([]) }),
      description: 'Fetch and prune one or more local bare mirrors.',
      output: repoMirrorCommandOutputSchema,
      options: z.object({
        jobs: z
          .number()
          .int()
          .min(1)
          .max(32)
          .optional()
          .describe('Maximum concurrent jobs'),
        maintenance: z
          .boolean()
          .default(false)
          .describe('Run explicit conservative GC after fetch'),
        source: z
          .enum(RepoMirrorInvocationSource)
          .default(RepoMirrorInvocationSource.Manual)
          .describe('Invocation source'),
      }),
      run: async (context) => {
        return this.output.runRepoMirror(
          context,
          'repo-mirrors fetch',
          async (signal) =>
            this.service.execute({
              maintenance: context.options.maintenance,
              names: context.args.names,
              signal,
              source: context.options.source,
              ...(context.options.jobs === undefined
                ? {}
                : { jobs: context.options.jobs }),
            })
        )
      },
    })
  }
}
