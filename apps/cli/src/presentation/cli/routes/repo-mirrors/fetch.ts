import { Cli, z } from 'incur'

import { runRepoMirrorRoute } from '../../repo-mirror-route-runtime.js'
import { getApplicationServices } from '../../services.js'

const route: Cli.FileCommand<z.ZodObject<any>, undefined, z.ZodObject<any>> = Cli.command({
  alias: { jobs: 'j' },
  args: z.object({ names: z.array(z.string()).default([]) }),
  description: 'Fetch and prune one or more local bare mirrors.',
  options: z.object({
    jobs: z.number().int().min(1).max(32).optional().describe('Maximum concurrent jobs'),
    maintenance: z.boolean().default(false).describe('Run explicit conservative GC after fetch'),
    source: z.enum(['manual', 'scheduler']).default('manual').describe('Invocation source'),
  }),
  async run(context) {
    return runRepoMirrorRoute(context, 'repo-mirrors fetch', async (signal) =>
      getApplicationServices().repoMirrorManager.fetch({
        maintenance: context.options.maintenance,
        names: context.args.names,
        signal,
        source: context.options.source,
        ...(context.options.jobs === undefined ? {} : { jobs: context.options.jobs }),
      }),
    )
  },
})

export default route
