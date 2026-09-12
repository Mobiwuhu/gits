import { Cli, z } from 'incur'

import { pushTask } from '../../../application/use-cases/push-task.js'
import { runRoute, taskRoot } from '../route-runtime.js'
import { getApplicationServices } from '../services.js'

const route: Cli.FileCommand<z.ZodObject<any>, undefined, z.ZodObject<any>> = Cli.command({
  args: z.object({ repos: z.array(z.string()).default([]) }),
  description: 'Push task branches to origin with upstream tracking.',
  options: z.object({
    all: z.boolean().default(false).describe('Push every configured repository'),
    dryRun: z.boolean().default(false).describe('Ask Git to simulate the push'),
  }),
  async run(context) {
    return runRoute(
      context,
      'push',
      async (signal) => {
        return pushTask(getApplicationServices(), {
          all: context.options.all,
          dryRun: context.options.dryRun,
          interactive: !context.agent,
          renderProgress: !context.agent,
          repositories: context.args.repos,
          root: await taskRoot(context),
          signal,
        })
      },
      [{ command: 'status', description: 'Inspect repository state after pushing' }],
    )
  },
})

export default route
