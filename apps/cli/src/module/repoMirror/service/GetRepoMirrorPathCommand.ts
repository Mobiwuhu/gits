import { IGetRepoMirrorPathService } from '@gits/core'
import { Inject } from '@wendellhu/redi'
import { Cli, z } from 'incur'

import { ICliOutputService } from '../../../contract/index'
import type {
  CliContext,
  CliInstance,
  IRepoMirrorSubcommand,
} from '../../../contract/index'

export class GetRepoMirrorPathCommand implements IRepoMirrorSubcommand {
  constructor(
    @Inject(IGetRepoMirrorPathService)
    private readonly service: IGetRepoMirrorPathService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService
  ) {}

  register(cli: CliInstance): void {
    cli.command(
      'path',
      Cli.command({
        args: z.object({ name: z.string().describe('Mirror name') }),
        description: 'Print the absolute path of a local bare mirror.',
        run: async (rawContext) => {
          const context = rawContext as CliContext & {
            readonly args: { readonly name: string }
          }
          return this.output.runValue(
            context,
            'repo-mirrors path',
            async () => this.service.execute({ name: context.args.name }),
            (path) => path,
            { plain: true }
          )
        },
      })
    )
  }
}
