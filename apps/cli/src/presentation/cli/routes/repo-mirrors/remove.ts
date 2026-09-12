import { Cli, z } from 'incur'

import { confirmAction } from '../../confirmation.js'
import { runRepoMirrorRoute } from '../../repo-mirror-route-runtime.js'
import { getApplicationServices } from '../../services.js'

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

const route: Cli.FileCommand<z.ZodObject<any>, undefined, z.ZodObject<any>> = Cli.command({
  alias: { jobs: 'j' },
  args: z.object({ names: z.array(z.string()).min(1) }),
  description: 'Remove one or more repository mirrors.',
  destructive: true,
  hint: '--force may leave installed repositories unable to read borrowed Git objects.',
  options: removeOptions,
  async run(context) {
    return runRepoMirrorRoute(context, 'repo-mirrors remove', async (signal) => {
      const confirmed = await confirmAction(
        context,
        context.options.yes,
        `Remove repo mirror${context.args.names.length === 1 ? '' : 's'} ${context.args.names.join(', ')}?`,
      )
      return getApplicationServices().repoMirrorManager.remove({
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
})

export default route
