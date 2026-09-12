import { Cli, z } from 'incur'

import { confirmAction } from '../../confirmation.js'
import { runRepoMirrorRoute } from '../../repo-mirror-route-runtime.js'
import { getApplicationServices } from '../../services.js'

const route: Cli.FileCommand<z.ZodObject<any>, undefined, z.ZodObject<any>> = Cli.command({
  args: z.object({ names: z.array(z.string()).default([]) }),
  description: 'Check or repair mirror health.',
  destructive: true,
  options: z.object({
    deep: z.boolean().default(false).describe('Run a full Git object fsck'),
    fix: z.boolean().default(false).describe('Repair missing or invalid mirrors'),
    remote: z.boolean().default(false).describe('Check non-interactive remote access'),
    yes: z.boolean().default(false).describe('Confirm repairs without prompting'),
  }),
  async run(context) {
    return runRepoMirrorRoute(context, 'repo-mirrors doctor', async (signal) => {
      const confirmed =
        !context.options.fix ||
        (await confirmAction(context, context.options.yes, 'Repair invalid repo mirrors?'))
      return getApplicationServices().repoMirrorManager.doctor({
        confirmed,
        deep: context.options.deep,
        fix: context.options.fix,
        names: context.args.names,
        remote: context.options.remote,
        signal,
      })
    })
  },
})

export default route
