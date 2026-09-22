import { IListRepoMirrorService } from '@usegits/core'
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

export class ListRepoMirrorCommand implements IRepoMirrorSubcommand {
  constructor(
    @Inject(IListRepoMirrorService)
    private readonly service: IListRepoMirrorService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService
  ) {}

  register(cli: CliInstance): void {
    cli.command('list', {
      args: z.object({ names: z.array(z.string()).default([]) }),
      description: 'List machine-local Git repository mirrors.',
      output: repoMirrorCommandOutputSchema,
      options: z.object({
        wide: z.boolean().default(false).describe('Show full mirror details'),
      }),
      run: async (context) => {
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
  }
}
