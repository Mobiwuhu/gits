import { Cli, z } from 'incur'

import { runRepoMirrorRoute } from '../../repo-mirror-route-runtime.js'
import { getApplicationServices } from '../../services.js'

const route: Cli.FileCommand<z.ZodObject<any>, undefined, z.ZodObject<any>> = Cli.command({
  alias: { jobs: 'j' },
  args: z.object({ names: z.array(z.string()).default([]) }),
  description: 'Change mirror URLs, aliases, or schedule.',
  options: z.object({
    addAlias: z.array(z.string()).default([]).describe('Add an equivalent install URL'),
    jobs: z.number().int().min(1).max(32).optional().describe('Maximum concurrent jobs'),
    removeAlias: z.array(z.string()).default([]).describe('Remove an install URL alias'),
    schedule: z.string().optional().describe('auto, off, or a five-field cron expression'),
    url: z.string().optional().describe('Select the active fetch URL'),
  }),
  async run(context) {
    return runRepoMirrorRoute(context, 'repo-mirrors set', async (signal) =>
      getApplicationServices().repoMirrorManager.set({
        addAliases: context.options.addAlias,
        names: context.args.names,
        removeAliases: context.options.removeAlias,
        signal,
        ...(context.options.jobs === undefined ? {} : { jobs: context.options.jobs }),
        ...(context.options.schedule === undefined ? {} : { schedule: context.options.schedule }),
        ...(context.options.url === undefined ? {} : { url: context.options.url }),
      }),
    )
  },
})

export default route
