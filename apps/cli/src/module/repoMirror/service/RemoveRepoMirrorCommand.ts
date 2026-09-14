import { IRemoveRepoMirrorService } from '@gits/core'
import { Inject } from '@wendellhu/redi'
import { Cli, z } from 'incur'

import {
  ICliConfirmationService,
  ICliOutputService,
  type CliContext,
  type CliInstance,
  type IRepoMirrorSubcommand,
} from '../../../contract/index'

interface RemoveOptions {
  readonly detachDependents: boolean
  readonly force: boolean
  readonly jobs?: number
  readonly purge: boolean
  readonly yes: boolean
}

const removeOptions = z
  .object({
    detachDependents: z
      .boolean()
      .default(false)
      .describe('Make dependent repositories self-contained before removal'),
    force: z.boolean().default(false).describe('Bypass dependent-repository protection'),
    jobs: z.number().int().min(1).max(32).optional().describe('Maximum concurrent jobs'),
    purge: z.boolean().default(false).describe('Delete immediately instead of moving to trash'),
    yes: z.boolean().default(false).describe('Confirm removal without prompting'),
  })
  .refine(({ detachDependents, force }) => !(detachDependents && force), {
    message: '--force and --detach-dependents cannot be combined.',
  })

export class RemoveRepoMirrorCommand implements IRepoMirrorSubcommand {
  constructor(
    @Inject(IRemoveRepoMirrorService) private readonly service: IRemoveRepoMirrorService,
    @Inject(ICliConfirmationService) private readonly confirmation: ICliConfirmationService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService,
  ) {}

  register(cli: CliInstance): void {
    cli.command(
      'remove',
      Cli.command({
        alias: { jobs: 'j' },
        args: z.object({ names: z.array(z.string()).min(1) }),
        description: 'Remove one or more repository mirrors.',
        destructive: true,
        hint: '--force may leave installed repositories unable to read borrowed Git objects.',
        options: removeOptions,
        run: async (rawContext) => {
          const context = rawContext as CliContext & {
            readonly args: { readonly names: readonly string[] }
            readonly options: RemoveOptions
          }
          return this.output.runRepoMirror(context, 'repo-mirrors remove', async (signal) => {
            const confirmed = await this.confirmation.confirm(
              context,
              context.options.yes,
              `Remove repo mirror${context.args.names.length === 1 ? '' : 's'} ${context.args.names.join(', ')}?`,
            )
            return this.service.execute({
              confirmed,
              detachDependents: context.options.detachDependents,
              force: context.options.force,
              names: context.args.names,
              purge: context.options.purge,
              signal,
              ...(context.options.jobs === undefined ? {} : { jobs: context.options.jobs }),
            })
          })
        },
      }),
    )
  }
}
