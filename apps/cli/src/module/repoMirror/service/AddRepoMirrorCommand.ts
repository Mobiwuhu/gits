import {
  IAddRepoMirrorService,
  IAddTaskRepoMirrorsService,
  RepoMirrorUsageError,
} from '@usegit/core'
import { Inject } from '@wendellhu/redi'
import { Cli, z } from 'incur'

import {
  ICliConfirmationService,
  ICliOutputService,
  ICliRuntimeService,
} from '../../../contract/index'
import type {
  CliContext,
  CliInstance,
  IRepoMirrorSubcommand,
} from '../../../contract/index'

interface AddOptions {
  readonly alias: readonly string[]
  readonly dryRun: boolean
  readonly fromTask: boolean
  readonly jobs?: number
  readonly name?: string
  readonly schedule?: string
  readonly yes: boolean
}

export class AddRepoMirrorCommand implements IRepoMirrorSubcommand {
  constructor(
    @Inject(IAddRepoMirrorService) private readonly add: IAddRepoMirrorService,
    @Inject(IAddTaskRepoMirrorsService)
    private readonly addFromTask: IAddTaskRepoMirrorsService,
    @Inject(ICliConfirmationService)
    private readonly confirmation: ICliConfirmationService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService,
    @Inject(ICliRuntimeService) private readonly runtime: ICliRuntimeService
  ) {}

  register(cli: CliInstance): void {
    cli.command(
      'add',
      Cli.command({
        alias: { jobs: 'j' },
        args: z.object({ targets: z.array(z.string()).default([]) }),
        description: 'Create one or more local bare Git mirrors.',
        options: z.object({
          alias: z
            .array(z.string())
            .default([])
            .describe('Equivalent URL used for install matching'),
          dryRun: z
            .boolean()
            .default(false)
            .describe('Preview without cloning or changing config'),
          fromTask: z
            .boolean()
            .default(false)
            .describe('Read repository URLs from task.config.jsonc'),
          jobs: z
            .number()
            .int()
            .min(1)
            .max(32)
            .optional()
            .describe('Maximum concurrent jobs'),
          name: z.string().optional().describe('Name for a single mirror'),
          schedule: z
            .string()
            .optional()
            .describe('auto, off, or a five-field cron expression'),
          yes: z
            .boolean()
            .default(false)
            .describe('Confirm creation without prompting'),
        }),
        run: async (rawContext) => {
          const context = rawContext as CliContext & {
            readonly args: { readonly targets: readonly string[] }
            readonly options: AddOptions
          }
          return this.output.runRepoMirror(
            context,
            'repo-mirrors add',
            async (signal) => {
              if (
                context.options.fromTask &&
                (context.options.name !== undefined ||
                  context.options.alias.length > 0)
              ) {
                throw new RepoMirrorUsageError(
                  '--from-task cannot be combined with --name or --alias.'
                )
              }
              const confirmed =
                context.options.dryRun ||
                (await this.confirmation.confirm(
                  context,
                  context.options.yes,
                  context.options.fromTask
                    ? 'Create repo mirror data for repositories from this task?'
                    : `Create repo mirror data for ${context.args.targets.length} configured URL${context.args.targets.length === 1 ? '' : 's'}?`
                ))
              if (!confirmed) {
                throw new RepoMirrorUsageError(
                  'Creation requires confirmation or --yes.'
                )
              }
              if (context.options.fromTask) {
                return this.addFromTask.execute({
                  dryRun: context.options.dryRun,
                  repositories: context.args.targets,
                  root: await this.runtime.taskRoot(context),
                  signal,
                  ...(context.options.jobs === undefined
                    ? {}
                    : { jobs: context.options.jobs }),
                  ...(context.options.schedule === undefined
                    ? {}
                    : { schedule: context.options.schedule }),
                })
              }
              return this.add.execute({
                aliases: context.options.alias,
                dryRun: context.options.dryRun,
                signal,
                urls: context.args.targets,
                ...(context.options.jobs === undefined
                  ? {}
                  : { jobs: context.options.jobs }),
                ...(context.options.name === undefined
                  ? {}
                  : { name: context.options.name }),
                ...(context.options.schedule === undefined
                  ? {}
                  : { schedule: context.options.schedule }),
              })
            }
          )
        },
      })
    )
  }
}
