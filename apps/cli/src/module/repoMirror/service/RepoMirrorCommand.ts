import { IListRepoMirrorService } from '@usegits/core'
import { Inject, Many } from '@wendellhu/redi'
import { Cli, z } from 'incur'

import {
  cliGlobalsSchema,
  ICliOutputService,
  IRepoMirrorSubcommand,
  repoMirrorCommandOutputSchema,
} from '../../../contract/index'
import type { CliInstance, ICliCommand } from '../../../contract/index'

export class RepoMirrorCommand implements ICliCommand {
  constructor(
    @Inject(IListRepoMirrorService)
    private readonly service: IListRepoMirrorService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService,
    @Many(IRepoMirrorSubcommand)
    private readonly subcommands: IRepoMirrorSubcommand[]
  ) {}

  register(cli: CliInstance): void {
    const repoMirrors = Cli.create('repo-mirrors', {
      args: z.object({ names: z.array(z.string()).default([]) }),
      description: 'List machine-local Git repository mirrors.',
      globals: cliGlobalsSchema,
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
          {
            nextCommands: [
              {
                command: 'repo-mirrors add',
                description: 'Create a repository mirror',
              },
              {
                command: 'repo-mirrors fetch',
                description: 'Refresh repository mirrors',
              },
            ],
            wide: context.options.wide,
          }
        )
      },
    })
    for (const subcommand of this.subcommands) {
      subcommand.register(repoMirrors)
    }
    cli.command(repoMirrors)
  }
}
