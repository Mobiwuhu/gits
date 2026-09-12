import { Cli, z } from 'incur'

import { initializeTask } from '../../../application/task/initialize-task.js'
import { commandRoot, runRoute } from '../route-runtime.js'
import { getApplicationServices } from '../services.js'

const route: Cli.FileCommand<undefined, undefined, z.ZodObject<any>> = Cli.command({
  description: 'Create or complete a task branch set workspace.',
  options: z.object({
    scan: z
      .string()
      .optional()
      .describe('Source task directory; imports its task.config.jsonc and scripts/'),
  }),
  async run(context) {
    return runRoute(
      context,
      'init',
      async (signal) =>
        initializeTask(getApplicationServices(), {
          root: await commandRoot(context),
          signal,
          ...(context.options.scan === undefined ? {} : { scanPath: context.options.scan }),
        }),
      [{ command: 'install', description: 'Prepare configured repositories' }],
    )
  },
})

export default route
