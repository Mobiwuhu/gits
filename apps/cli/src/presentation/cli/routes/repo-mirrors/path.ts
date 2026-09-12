import { Cli, z } from 'incur'

import { runRepoMirrorValueRoute } from '../../repo-mirror-route-runtime.js'
import { getApplicationServices } from '../../services.js'

const route: Cli.FileCommand<z.ZodObject<any>, undefined, undefined> = Cli.command({
  args: z.object({ name: z.string().describe('Mirror name') }),
  description: 'Print the absolute path of a local bare mirror.',
  async run(context) {
    return runRepoMirrorValueRoute(
      context,
      'repo-mirrors path',
      async () => getApplicationServices().repoMirrorManager.path(context.args.name),
      (path) => path,
      { plain: true },
    )
  },
})

export default route
