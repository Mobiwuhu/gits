import { Cli, z } from 'incur'

import { selectRepositories } from '../../../../application/task/select-repositories.js'
import { RepoMirrorUsageError } from '../../../../domain/repo-mirror/errors.js'
import { confirmAction } from '../../confirmation.js'
import { runRepoMirrorRoute } from '../../repo-mirror-route-runtime.js'
import { taskRoot } from '../../route-runtime.js'
import { getApplicationServices } from '../../services.js'

const route: Cli.FileCommand<z.ZodObject<any>, undefined, z.ZodObject<any>> = Cli.command({
  alias: { jobs: 'j' },
  args: z.object({ targets: z.array(z.string()).default([]) }),
  description: 'Create one or more local bare Git mirrors.',
  options: z.object({
    alias: z.array(z.string()).default([]).describe('Equivalent URL used for install matching'),
    dryRun: z.boolean().default(false).describe('Preview without cloning or changing config'),
    fromTask: z.boolean().default(false).describe('Read repository URLs from task.config.jsonc'),
    jobs: z.number().int().min(1).max(32).optional().describe('Maximum concurrent jobs'),
    name: z.string().optional().describe('Name for a single mirror'),
    schedule: z.string().optional().describe('auto, off, or a five-field cron expression'),
    yes: z.boolean().default(false).describe('Confirm creation without prompting'),
  }),
  async run(context) {
    return runRepoMirrorRoute(
      context,
      'repo-mirrors add',
      async (signal) => {
        const services = getApplicationServices()
        let urls = context.args.targets
        if (context.options.fromTask) {
          if (context.options.name !== undefined || context.options.alias.length > 0) {
            throw new RepoMirrorUsageError('--from-task cannot be combined with --name or --alias.')
          }
          const loaded = await services.configurationStore.load(await taskRoot(context))
          urls = selectRepositories(loaded.configuration, context.args.targets).map(
            (repository) => repository.url,
          )
        }
        const confirmed =
          context.options.dryRun ||
          (await confirmAction(
            context,
            context.options.yes,
            `Create repo mirror data for ${urls.length} configured URL${urls.length === 1 ? '' : 's'}?`,
          ))
        if (!confirmed) throw new RepoMirrorUsageError('Creation requires confirmation or --yes.')
        return services.repoMirrorManager.add({
          aliases: context.options.alias,
          dryRun: context.options.dryRun,
          signal,
          urls,
          ...(context.options.jobs === undefined ? {} : { jobs: context.options.jobs }),
          ...(context.options.name === undefined ? {} : { name: context.options.name }),
          ...(context.options.schedule === undefined ? {} : { schedule: context.options.schedule }),
        })
      },
      {
        nextCommands: [{ command: 'repo-mirrors list', description: 'Inspect configured mirrors' }],
      },
    )
  },
})

export default route
