import { IGetRepoMirrorLogsService } from '@usegits/core'
import { Inject } from '@wendellhu/redi'
import { z } from 'incur'

import {
  ICliOutputService,
  repoMirrorLogsOutputSchema,
} from '../../../contract/index'
import type {
  CliInstance,
  IRepoMirrorSubcommand,
} from '../../../contract/index'

export class GetRepoMirrorLogsCommand implements IRepoMirrorSubcommand {
  constructor(
    @Inject(IGetRepoMirrorLogsService)
    private readonly service: IGetRepoMirrorLogsService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService
  ) {}

  register(cli: CliInstance): void {
    cli.command('logs', {
      args: z.object({ name: z.string().describe('Mirror name') }),
      description: 'Read recent structured mirror run logs.',
      output: repoMirrorLogsOutputSchema,
      options: z.object({
        follow: z.boolean().default(false).describe('Follow new log events'),
        lines: z
          .number()
          .int()
          .min(1)
          .max(10_000)
          .default(100)
          .describe('Maximum log lines'),
      }),
      run: (context) => {
        if (context.options.follow) {
          return this.#follow(context.args.name, context.options.lines)
        }
        return this.output.runValue(
          context,
          'repo-mirrors logs',
          async () =>
            this.service.execute({
              lines: context.options.lines,
              name: context.args.name,
            }),
          (lines) =>
            lines.length === 0 ? 'No mirror logs found.' : lines.join('\n')
        )
      },
    })
  }

  async *#follow(name: string, lines: number): AsyncGenerator<string, void> {
    const controller = new AbortController()
    const interrupt = (): void => {
      controller.abort()
    }
    process.once('SIGINT', interrupt)
    try {
      yield* this.service.follow({ lines, name, signal: controller.signal })
    } finally {
      process.removeListener('SIGINT', interrupt)
    }
  }
}
