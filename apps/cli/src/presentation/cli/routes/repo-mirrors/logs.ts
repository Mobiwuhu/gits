import { Cli, z } from 'incur'

import { runRepoMirrorValueRoute } from '../../repo-mirror-route-runtime.js'
import { getApplicationServices } from '../../services.js'

const route: Cli.FileCommand<z.ZodObject<any>, undefined, z.ZodObject<any>> = Cli.command({
  args: z.object({ name: z.string().describe('Mirror name') }),
  description: 'Read recent structured mirror run logs.',
  options: z.object({
    follow: z.boolean().default(false).describe('Follow new log events'),
    lines: z.number().int().min(1).max(10_000).default(100).describe('Maximum log lines'),
  }),
  run(context) {
    if (context.options.follow) return followLogs(context.args.name, context.options.lines)
    return runRepoMirrorValueRoute(
      context,
      'repo-mirrors logs',
      async () =>
        getApplicationServices().repoMirrorManager.logs(context.args.name, context.options.lines),
      (lines) => (lines.length === 0 ? 'No mirror logs found.' : lines.join('\n')),
    )
  },
})

async function* followLogs(name: string, lines: number): AsyncGenerator<string, void> {
  const controller = new AbortController()
  const interrupt = (): void => controller.abort()
  process.once('SIGINT', interrupt)
  try {
    yield* getApplicationServices().repoMirrorManager.followLogs(name, lines, controller.signal)
  } finally {
    process.removeListener('SIGINT', interrupt)
  }
}

export default route
