import { IUninstallService } from '@gits/core'
import { Inject } from '@wendellhu/redi'
import { Cli, z } from 'incur'

import {
  ICliConfirmationService,
  ICliOutputService,
  type CliContext,
  type CliInstance,
  type ICliCommand,
} from '../../../contract/index'

interface UninstallOptions {
  readonly detachDependents: boolean
  readonly dryRun: boolean
  readonly force: boolean
  readonly yes: boolean
}

const uninstallOptions = z
  .object({
    detachDependents: z
      .boolean()
      .default(false)
      .describe('Make mirror-dependent repositories self-contained first'),
    dryRun: z.boolean().default(false).describe('List every removal target without changing files'),
    force: z.boolean().default(false).describe('Bypass mirror-dependent repository protection'),
    yes: z.boolean().default(false).describe('Confirm uninstall without prompting'),
  })
  .refine(({ detachDependents, force }) => !(detachDependents && force), {
    message: '--force and --detach-dependents cannot be combined.',
  })

export class UninstallCommand implements ICliCommand {
  constructor(
    @Inject(IUninstallService) private readonly service: IUninstallService,
    @Inject(ICliConfirmationService) private readonly confirmation: ICliConfirmationService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService,
  ) {}

  register(cli: CliInstance): void {
    cli.command(
      'uninstall',
      Cli.command({
        description: 'Remove all gits machine data and native scheduler projections.',
        destructive: true,
        hint: 'Use --dry-run first. --force may break repositories that borrow mirror objects.',
        options: uninstallOptions,
        run: async (rawContext) => {
          const context = rawContext as CliContext & { readonly options: UninstallOptions }
          return this.output.runUninstall(context, async (signal) => {
            const confirmed =
              context.options.dryRun ||
              (await this.confirmation.confirm(
                context,
                context.options.yes,
                'Permanently remove all gits mirrors, state, logs, and native schedules?',
              ))
            return this.service.execute({
              confirmed,
              detachDependents: context.options.detachDependents,
              dryRun: context.options.dryRun,
              force: context.options.force,
              signal,
            })
          })
        },
      }),
    )
  }
}
