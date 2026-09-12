import { Cli, z } from 'incur'

import { installTask } from '../../../application/use-cases/install-task.js'
import { parseJobs, runRoute, taskRoot } from '../route-runtime.js'
import { getApplicationServices } from '../services.js'

const route: Cli.FileCommand<z.ZodObject<any>, undefined, z.ZodObject<any>> = Cli.command({
  alias: { jobs: 'j' },
  args: z.object({ repos: z.array(z.string()).default([]) }),
  description: 'Clone repositories, prepare task branches, and align checkout directories.',
  options: z.object({
    jobs: z.string().optional().describe('Maximum concurrent network jobs'),
  }),
  async run(context) {
    return runRoute(
      context,
      'install',
      async (signal) => {
        const jobs = parseJobs(context.options.jobs)
        return installTask(getApplicationServices(), {
          interactive: !context.agent,
          renderProgress: !context.agent,
          repositories: context.args.repos,
          root: await taskRoot(context),
          signal,
          ...(jobs === undefined ? {} : { jobs }),
        })
      },
      [{ command: 'status', description: 'Inspect prepared repositories' }],
    )
  },
})

export default route
