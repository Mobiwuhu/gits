import { Cli, z } from 'incur'

import { switchTask } from '../../../application/use-cases/switch-task.js'
import { parseJobs, runRoute, taskRoot } from '../route-runtime.js'
import { getApplicationServices } from '../services.js'

const route: Cli.FileCommand<z.ZodObject<any>, undefined, z.ZodObject<any>> = Cli.command({
  alias: { jobs: 'j' },
  args: z.object({ repos: z.array(z.string()).default([]) }),
  description: 'Switch repositories to their configured task branches.',
  options: z.object({
    jobs: z.string().optional().describe('Maximum concurrent fetch jobs'),
    stash: z.boolean().default(false).describe('Stash dirty worktrees before switching'),
  }),
  async run(context) {
    return runRoute(
      context,
      'switch',
      async (signal) => {
        const jobs = parseJobs(context.options.jobs)
        return switchTask(getApplicationServices(), {
          interactive: !context.agent,
          renderProgress: !context.agent,
          repositories: context.args.repos,
          root: await taskRoot(context),
          signal,
          stash: context.options.stash,
          ...(jobs === undefined ? {} : { jobs }),
        })
      },
      [{ command: 'status', description: 'Inspect switched repository state' }],
    )
  },
})

export default route
