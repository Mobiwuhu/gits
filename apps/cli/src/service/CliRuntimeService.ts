import { GitsError, ITaskRootService, UsageError } from '@gits/core'
import { Inject } from '@wendellhu/redi'

import type { CliContext, ICliRuntimeService } from '../contract/index'

export class CliRuntimeService implements ICliRuntimeService {
  constructor(
    @Inject(ITaskRootService) private readonly taskRootService: ITaskRootService
  ) {}

  async commandRoot(context: CliContext): Promise<string> {
    return this.taskRootService.resolveWorkingDirectory(context.globals.cwd)
  }

  async taskRoot(context: CliContext): Promise<string> {
    const workingDirectory = await this.taskRootService.resolveWorkingDirectory(
      context.globals.cwd
    )
    return this.taskRootService.findTaskRoot(workingDirectory)
  }

  parseJobs(value: string | undefined): number | undefined {
    if (value === undefined) {
      return undefined
    }
    if (!/^\d+$/u.test(value)) {
      throw new UsageError('--jobs must be a positive integer.')
    }

    const jobs = Number(value)
    if (!Number.isSafeInteger(jobs) || jobs < 1) {
      throw new UsageError('--jobs must be a positive integer.')
    }
    return jobs
  }

  async runInterruptibly<T>(
    action: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController()
    const interrupt = (): void => {
      controller.abort()
    }
    process.once('SIGINT', interrupt)

    try {
      const value = await action(controller.signal)
      if (controller.signal.aborted) {
        throw new GitsError('interrupted', 'Command interrupted by user.', 130)
      }
      return value
    } finally {
      process.removeListener('SIGINT', interrupt)
    }
  }
}
