import { Cli, z } from 'incur'

import { runRepoMirrorRoute } from '../../repo-mirror-route-runtime.js'
import { getApplicationServices } from '../../services.js'

const route: Cli.FileCommand<z.ZodObject<any>, undefined, z.ZodObject<any>> = Cli.command({
  args: z.object({ names: z.array(z.string()).default([]) }),
  description: 'List machine-local Git repository mirrors.',
  options: z.object({ wide: z.boolean().default(false).describe('Show full mirror details') }),
  async run(context) {
    return runRepoMirrorRoute(
      context,
      'repo-mirrors list',
      async () =>
        getApplicationServices().repoMirrorManager.list({
          includeSize: context.options.wide,
          names: context.args.names,
        }),
      {
        nextCommands: [
          { command: 'repo-mirrors add', description: 'Create a repository mirror' },
          { command: 'repo-mirrors fetch', description: 'Refresh repository mirrors' },
        ],
        wide: context.options.wide,
      },
    )
  },
})

export default route
