import { IGetRepoMirrorPathService } from '@usegits/core'
import { Inject } from '@wendellhu/redi'
import { z } from 'incur'

import {
  ICliOutputService,
  repoMirrorPathOutputSchema,
} from '../../../contract/index'
import type {
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
    cli.command('path', {
      args: z.object({ name: z.string().describe('Mirror name') }),
      description: 'Print the absolute path of a local bare mirror.',
      output: repoMirrorPathOutputSchema,
      run: async (context) => {
        return this.output.runValue(
          context,
          'repo-mirrors path',
          async () => this.service.execute({ name: context.args.name }),
          (path) => path,
          { plain: true }
        )
      },
    })
  }
}
