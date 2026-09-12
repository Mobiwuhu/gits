import { Cli, z } from 'incur'

import { statusTask } from '../../../application/use-cases/status-task.js'
import { runRoute, taskRoot } from '../route-runtime.js'
import { getApplicationServices } from '../services.js'

const route: Cli.FileCommand<z.ZodObject<any>> = Cli.command({
  args: z.object({ repos: z.array(z.string()).default([]) }),
  description: 'Show aggregate Git state for task repositories.',
  async run(context) {
    return runRoute(
      context,
      'status',
      async (signal) =>
        statusTask(getApplicationServices(), {
          repositories: context.args.repos,
          root: await taskRoot(context),
          signal,
        }),
      [
        { command: 'fetch', description: 'Refresh remote-tracking refs' },
        { command: 'switch', description: 'Switch repositories to task branches' },
      ],
    )
  },
})

export default route
