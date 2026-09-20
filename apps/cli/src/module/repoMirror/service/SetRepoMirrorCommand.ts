import { ISetRepoMirrorService } from '@usegit/core'
import { Inject } from '@wendellhu/redi'
import { Cli, z } from 'incur'

import { ICliOutputService } from '../../../contract/index'
import type {
  CliContext,
  CliInstance,
  IRepoMirrorSubcommand,
} from '../../../contract/index'

interface SetOptions {
  readonly addAlias: readonly string[]
  readonly jobs?: number
  readonly removeAlias: readonly string[]
  readonly schedule?: string
  readonly url?: string
}

export class SetRepoMirrorCommand implements IRepoMirrorSubcommand {
  constructor(
    @Inject(ISetRepoMirrorService)
    private readonly service: ISetRepoMirrorService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService
  ) {}

  register(cli: CliInstance): void {
    cli.command(
      'set',
      Cli.command({
        alias: { jobs: 'j' },
        args: z.object({ names: z.array(z.string()).default([]) }),
        description: 'Change mirror URLs, aliases, or schedule.',
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
        run: async (rawContext) => {
          const context = rawContext as CliContext & {
            readonly args: { readonly names: readonly string[] }
            readonly options: SetOptions
          }
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
    )
  }
}
