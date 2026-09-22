import { ISetRepoMirrorService } from '@usegits/core'
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

export class SetRepoMirrorCommand implements IRepoMirrorSubcommand {
  constructor(
    @Inject(ISetRepoMirrorService)
    private readonly service: ISetRepoMirrorService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService
  ) {}

  register(cli: CliInstance): void {
    cli.command('set', {
      alias: { jobs: 'j' },
      args: z.object({ names: z.array(z.string()).default([]) }),
      description: 'Change mirror URLs, aliases, or schedule.',
      output: repoMirrorCommandOutputSchema,
      options: z.object({
        addAlias: z
          .array(z.string())
          .default([])
          .describe('Add an equivalent install URL'),
        jobs: z
          .number()
          .int()
          .min(1)
          .max(32)
          .optional()
          .describe('Maximum concurrent jobs'),
        removeAlias: z
          .array(z.string())
          .default([])
          .describe('Remove an install URL alias'),
        schedule: z
          .string()
          .optional()
          .describe('auto, off, or a five-field cron expression'),
        url: z.string().optional().describe('Select the active fetch URL'),
      }),
      run: async (context) => {
        return this.output.runRepoMirror(
          context,
          'repo-mirrors set',
          async (signal) =>
            this.service.execute({
              addAliases: context.options.addAlias,
              names: context.args.names,
              removeAliases: context.options.removeAlias,
              signal,
              ...(context.options.jobs === undefined
                ? {}
                : { jobs: context.options.jobs }),
              ...(context.options.schedule === undefined
                ? {}
                : { schedule: context.options.schedule }),
              ...(context.options.url === undefined
                ? {}
                : { url: context.options.url }),
            })
        )
      },
    })
  }
}
