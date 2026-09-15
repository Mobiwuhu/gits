import { Inject } from '@wendellhu/redi'

import {
  IRepoMirrorConfigurationService,
  IRepoMirrorLoggerService,
  IRepoMirrorStoreService,
} from '../../../contract/index'
import type {
  IGetRepoMirrorLogsService,
  FollowRepoMirrorLogsInput,
  GetRepoMirrorLogsInput,
} from '../../../contract/index'
import { validateRepoMirrorName } from './repoMirrorIdentity'

export class GetRepoMirrorLogsService implements IGetRepoMirrorLogsService {
  constructor(
    @Inject(IRepoMirrorConfigurationService)
    private readonly configuration: IRepoMirrorConfigurationService,
    @Inject(IRepoMirrorLoggerService)
    private readonly logger: IRepoMirrorLoggerService,
    @Inject(IRepoMirrorStoreService)
    private readonly store: IRepoMirrorStoreService
  ) {}

  async execute(input: GetRepoMirrorLogsInput): Promise<readonly string[]> {
    await this.#assertExists(input.name)
    return this.logger.readLines(input.name, input.lines)
  }

  async *follow(
    input: FollowRepoMirrorLogsInput
  ): AsyncGenerator<string, void> {
    await this.#assertExists(input.name)
    let previous = [...(await this.logger.readLines(input.name, input.lines))]
    for (const line of previous) {
      yield line
    }

    while (!input.signal.aborted) {
      await abortableDelay(500, input.signal)
      if (input.signal.aborted) {
        break
      }
      const current = [
        ...(await this.logger.readLines(input.name, input.lines)),
      ]
      const overlap = suffixPrefixOverlap(previous, current)
      for (const line of current.slice(overlap)) {
        yield line
      }
      previous = current
    }
  }

  async #assertExists(name: string): Promise<void> {
    validateRepoMirrorName(name)
    const configuration = await this.store.load()
    this.configuration.select(configuration, [name])
  }
}

function suffixPrefixOverlap(
  previous: readonly string[],
  current: readonly string[]
): number {
  const maximum = Math.min(previous.length, current.length)
  for (let size = maximum; size > 0; size -= 1) {
    const suffix = previous.slice(previous.length - size)
    const prefix = current.slice(0, size)
    if (suffix.every((line, index) => line === prefix[index])) {
      return size
    }
  }
  return 0
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) {
    return
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true }
    )
  })
}
