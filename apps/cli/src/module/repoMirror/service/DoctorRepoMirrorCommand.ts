import { IDoctorRepoMirrorService } from '@usegits/core'
import { Inject } from '@wendellhu/redi'
import { z } from 'incur'

import {
  ICliConfirmationService,
  ICliOutputService,
  repoMirrorCommandOutputSchema,
} from '../../../contract/index'
import type {
  CliInstance,
  IRepoMirrorSubcommand,
} from '../../../contract/index'

export class DoctorRepoMirrorCommand implements IRepoMirrorSubcommand {
  constructor(
    @Inject(IDoctorRepoMirrorService)
    private readonly service: IDoctorRepoMirrorService,
    @Inject(ICliConfirmationService)
    private readonly confirmation: ICliConfirmationService,
    @Inject(ICliOutputService) private readonly output: ICliOutputService
  ) {}

  register(cli: CliInstance): void {
    cli.command('doctor', {
      args: z.object({ names: z.array(z.string()).default([]) }),
      description: 'Check or repair mirror health.',
      destructive: true,
      output: repoMirrorCommandOutputSchema,
      options: z.object({
        deep: z.boolean().default(false).describe('Run a full Git object fsck'),
        fix: z
          .boolean()
          .default(false)
          .describe('Repair missing or invalid mirrors'),
        remote: z
          .boolean()
          .default(false)
          .describe('Check non-interactive remote access'),
        yes: z
          .boolean()
          .default(false)
          .describe('Confirm repairs without prompting'),
      }),
      run: async (context) => {
        return this.output.runRepoMirror(
          context,
          'repo-mirrors doctor',
          async (signal) => {
            const confirmed =
              !context.options.fix ||
              (await this.confirmation.confirm(
                context,
                context.options.yes,
                'Repair repo mirrors and scheduler artifacts?'
              ))
            return this.service.execute({
              confirmed,
              deep: context.options.deep,
              fix: context.options.fix,
              names: context.args.names,
              remote: context.options.remote,
              signal,
            })
          }
        )
      },
    })
  }
}
