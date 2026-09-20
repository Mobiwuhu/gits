import { IListRepoMirrorService } from '@usegits/core'
import { Inject } from '@wendellhu/redi'
import { Cli, z } from 'incur'

import { ICliOutputService } from '../../../contract/index'
import type {
  CliContext,
  CliInstance,
  IRepoMirrorSubcommand,
} from '../../../contract/index'

export class ListRepoMirrorCommand implements IRepoMirrorSubcommand {
  constructor(
    @Inject(IListRepoMirrorService)
    private readonly service: IListRepoMirrorService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService
  ) {}

  register(cli: CliInstance): void {
    cli.command(
      'list',
      Cli.command({
        args: z.object({ names: z.array(z.string()).default([]) }),
        description: 'List machine-local Git repository mirrors.',
        options: z.object({
          wide: z.boolean().default(false).describe('Show full mirror details'),
        }),
        run: async (rawContext) => {
          const context = rawContext as CliContext & {
            readonly args: { readonly names: readonly string[] }
            readonly options: { readonly wide: boolean }
          }
          return this.output.runRepoMirror(
            context,
            'repo-mirrors list',
            async () =>
              this.service.execute({
                includeSize: context.options.wide,
                names: context.args.names,
              }),
            { wide: context.options.wide }
          )
        },
      })
    )
  }
}
