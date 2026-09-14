import { IListRepoMirrorService } from '@gits/core'
import { Inject, Many } from '@wendellhu/redi'
import { Cli, z } from 'incur'

import {
  ICliOutputService,
  IRepoMirrorSubcommand,
  type CliContext,
  type CliInstance,
  type ICliCommand,
} from '../../../contract/index'

export class RepoMirrorCommand implements ICliCommand {
  constructor(
    @Inject(IListRepoMirrorService) private readonly service: IListRepoMirrorService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService,
    @Many(IRepoMirrorSubcommand) private readonly subcommands: IRepoMirrorSubcommand[],
  ) {}

  register(cli: CliInstance): void {
    const repoMirrors = Cli.create('repo-mirrors', {
      args: z.object({ names: z.array(z.string()).default([]) }),
      description: 'List machine-local Git repository mirrors.',
      options: z.object({ wide: z.boolean().default(false).describe('Show full mirror details') }),
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
          {
            nextCommands: [
              { command: 'repo-mirrors add', description: 'Create a repository mirror' },
              { command: 'repo-mirrors fetch', description: 'Refresh repository mirrors' },
            ],
            wide: context.options.wide,
          },
        )
      },
    })
    for (const subcommand of this.subcommands) subcommand.register(repoMirrors)
    cli.command(repoMirrors)
  }
}
