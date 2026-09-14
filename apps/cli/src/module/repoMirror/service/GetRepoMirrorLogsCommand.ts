import { IGetRepoMirrorLogsService } from '@gits/core'
import { Inject } from '@wendellhu/redi'
import { Cli, z } from 'incur'

import {
  ICliOutputService,
  type CliContext,
  type CliInstance,
  type IRepoMirrorSubcommand,
} from '../../../contract/index'

export class GetRepoMirrorLogsCommand implements IRepoMirrorSubcommand {
  constructor(
    @Inject(IGetRepoMirrorLogsService) private readonly service: IGetRepoMirrorLogsService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService,
  ) {}

  register(cli: CliInstance): void {
    cli.command(
      'logs',
      Cli.command({
        args: z.object({ name: z.string().describe('Mirror name') }),
        description: 'Read recent structured mirror run logs.',
        options: z.object({
          follow: z.boolean().default(false).describe('Follow new log events'),
          lines: z.number().int().min(1).max(10_000).default(100).describe('Maximum log lines'),
        }),
        run: (rawContext) => {
          const context = rawContext as CliContext & {
            readonly args: { readonly name: string }
            readonly options: { readonly follow: boolean; readonly lines: number }
          }
          if (context.options.follow) {
            return this.#follow(context.args.name, context.options.lines)
          }
          return this.output.runValue(
            context,
            'repo-mirrors logs',
            async () =>
              this.service.execute({ name: context.args.name, lines: context.options.lines }),
            (lines) => (lines.length === 0 ? 'No mirror logs found.' : lines.join('\n')),
          )
        },
      }),
    )
  }

  async *#follow(name: string, lines: number): AsyncGenerator<string, void> {
    const controller = new AbortController()
    const interrupt = (): void => controller.abort()
    process.once('SIGINT', interrupt)
    try {
      yield* this.service.follow({ name, lines, signal: controller.signal })
    } finally {
      process.removeListener('SIGINT', interrupt)
    }
  }
}
