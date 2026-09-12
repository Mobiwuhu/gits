import { Cli, z } from 'incur'

import { confirmAction } from '../confirmation.js'
import { getApplicationServices } from '../services.js'
import { runUninstallRoute } from '../uninstall-route-runtime.js'

const options = z
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

const route: Cli.FileCommand<undefined, undefined, z.ZodObject<any>> = Cli.command({
  description: 'Remove all gits machine data and native scheduler projections.',
  destructive: true,
  hint: 'Use --dry-run first. --force may break repositories that borrow mirror objects.',
  options,
  async run(context) {
    return runUninstallRoute(context, async (signal) => {
      const confirmed =
        context.options.dryRun ||
        (await confirmAction(
          context,
          context.options.yes,
          'Permanently remove all gits mirrors, state, logs, and native schedules?',
        ))
      return getApplicationServices().uninstaller.uninstall({
        confirmed,
        detachDependents: context.options.detachDependents,
        dryRun: context.options.dryRun,
        force: context.options.force,
        signal,
      })
    })
  },
})

export default route
