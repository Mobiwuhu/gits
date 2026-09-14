import { Optional } from '@wendellhu/redi'

import {
  ConcurrentRunStatus,
  IConcurrencyPresentationService,
  type IConcurrencyService,
  type ConcurrentPresentation,
  type ConcurrentRunnerOptions,
  type ConcurrentRunResult,
  type ConcurrentRunSummary,
  type ConcurrentTaskReporter,
  type ConcurrentWorker,
} from '../contract/index'

const silentTaskReporter: ConcurrentTaskReporter = {
  enabled: false,
  update: () => undefined,
  write: () => undefined,
}

export class ConcurrencyService implements IConcurrencyService {
  constructor(
    @Optional(IConcurrencyPresentationService)
    private readonly presentationService: IConcurrencyPresentationService | null = null,
  ) {}

  resolve(workCount: number, jobs?: number): number {
    if (!Number.isInteger(workCount) || workCount < 0) {
      throw new RangeError('workCount must be a non-negative integer')
    }

    if (workCount === 0) return 0
    if (jobs === undefined) return Math.min(4, workCount)
    if (!Number.isInteger(jobs) || jobs < 1) {
      throw new RangeError('jobs must be a positive integer')
    }

    return Math.min(jobs, workCount)
  }

  run<T, R>(
    items: readonly T[],
    worker: ConcurrentWorker<T, R>,
    options: ConcurrentRunnerOptions<T, R> = {},
  ): Promise<ConcurrentRunSummary<T, R>> {
    const concurrency = this.resolve(items.length, options.concurrency)
    const presentation =
      concurrency > 0 && options.presentation?.enabled === true
        ? this.presentationService?.create(items, concurrency, options.presentation)
        : undefined
    return this.runWithPresentation(items, worker, options, presentation)
  }

  private async runWithPresentation<T, R>(
    items: readonly T[],
    worker: ConcurrentWorker<T, R>,
    options: ConcurrentRunnerOptions<T, R>,
    presentation?: ConcurrentPresentation<T, R>,
  ): Promise<ConcurrentRunSummary<T, R>> {
    const concurrency = this.resolve(items.length, options.concurrency)
    if (concurrency === 0) return { aborted: options.signal?.aborted ?? false, results: [] }
    presentation?.start()

    const scheduled = Array.from<undefined, ConcurrentRunResult<T, R> | undefined>(
      { length: items.length },
      () => undefined,
    )
    let nextIndex = 0

    const runWorker = async (): Promise<void> => {
      while (nextIndex < items.length && !options.signal?.aborted) {
        const index = nextIndex
        nextIndex += 1
        const item = items[index] as T
        this.notifyStart(options.onStart, item, index)

        let result: ConcurrentRunResult<T, R>
        try {
          const value = await worker(
            item,
            index,
            options.signal,
            presentation?.reporter(index) ?? silentTaskReporter,
          )
          result = { index, item, status: ConcurrentRunStatus.Fulfilled, value }
        } catch (error: unknown) {
          result = { error, index, item, status: ConcurrentRunStatus.Rejected }
        }

        scheduled[index] = result
        presentation?.settle(result)
        this.notifySettled(options.onSettled, result)
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => runWorker()))

    const results = items.map((item, index): ConcurrentRunResult<T, R> => {
      return scheduled[index] ?? { index, item, status: ConcurrentRunStatus.NotRun }
    })
    for (const result of results) presentation?.settle(result)
    await presentation?.finish()

    return { aborted: options.signal?.aborted ?? false, results }
  }

  private notifyStart<T>(
    listener: ((item: T, index: number) => void) | undefined,
    item: T,
    index: number,
  ): void {
    try {
      listener?.(item, index)
    } catch {
      // Progress rendering must not interrupt independent repository work.
    }
  }

  private notifySettled<T, R>(
    listener: ((result: ConcurrentRunResult<T, R>) => void) | undefined,
    result: ConcurrentRunResult<T, R>,
  ): void {
    try {
      listener?.(result)
    } catch {
      // Final rendering is likewise outside the worker failure boundary.
    }
  }
}
