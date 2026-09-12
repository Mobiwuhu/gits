import { Cli, z } from 'incur'

import { fetchTask } from '../../../application/use-cases/fetch-task.js'
import { parseJobs, runRoute, taskRoot } from '../route-runtime.js'
import { getApplicationServices } from '../services.js'

const route: Cli.FileCommand<z.ZodObject<any>, undefined, z.ZodObject<any>> = Cli.command({
  alias: { jobs: 'j' },
  args: z.object({ repos: z.array(z.string()).default([]) }),
  description: 'Fetch origin and prune remote-tracking refs for repositories.',
  options: z.object({
    jobs: z.string().optional().describe('Maximum concurrent network jobs'),
  }),
  async run(context) {
    return runRoute(
      context,
      'fetch',
      async (signal) => {
        const jobs = parseJobs(context.options.jobs)
        return fetchTask(getApplicationServices(), {
          interactive: !context.agent,
          renderProgress: !context.agent,
          repositories: context.args.repos,
          root: await taskRoot(context),
          signal,
          ...(jobs === undefined ? {} : { jobs }),
        })
      },
      [{ command: 'status', description: 'Inspect refreshed repository state' }],
    )
  },
})

export default route
