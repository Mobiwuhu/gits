import type { Writable } from 'node:stream'

import { Listr, type ListrTask } from 'listr2'

export type ConcurrentRunResult<T, R> =
  | Readonly<{
      index: number
      item: T
      status: 'fulfilled'
      value: R
    }>
  | Readonly<{
      error: unknown
      index: number
      item: T
      status: 'rejected'
    }>
  | Readonly<{
      index: number
      item: T
      status: 'not-run'
    }>

export type ConcurrentRunSummary<T, R> = Readonly<{
  aborted: boolean
  results: readonly ConcurrentRunResult<T, R>[]
}>

export type ConcurrentWorker<T, R> = (
  item: T,
  index: number,
  signal: AbortSignal | undefined,
  task: ConcurrentTaskReporter,
) => Promise<R>

export interface ConcurrentTaskReporter {
  readonly enabled: boolean
  readonly update: (message: string) => void
  readonly write: (chunk: string) => void
}

export type ConcurrentTaskOutcome = Readonly<{
  message?: string
  status: 'completed' | 'failed' | 'skipped'
}>

export type ConcurrentRunPresentation<T, R> = Readonly<{
  enabled: boolean
  outcome?: (value: R, item: T, index: number) => ConcurrentTaskOutcome
  title: (item: T, index: number) => string
}>

export type ConcurrentRunnerOptions<T, R> = Readonly<{
  concurrency?: number
  onSettled?: (result: ConcurrentRunResult<T, R>) => void
  onStart?: (item: T, index: number) => void
  presentation?: ConcurrentRunPresentation<T, R>
  signal?: AbortSignal
}>

const silentTaskReporter: ConcurrentTaskReporter = {
  enabled: false,
  update: () => undefined,
  write: () => undefined,
}

/**
 * Computes the number of workers for a network-style fan-out. The default
 * follows the product contract while a supplied jobs value is validated early.
 */
export function resolveConcurrency(workCount: number, jobs?: number): number {
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

/**
 * Runs independent work without letting one rejection cancel other items.
 * Results preserve the input order, including items left unstarted by abort.
 */
export async function runConcurrently<T, R>(
  items: readonly T[],
  worker: ConcurrentWorker<T, R>,
  options: ConcurrentRunnerOptions<T, R> = {},
): Promise<ConcurrentRunSummary<T, R>> {
  const concurrency = resolveConcurrency(items.length, options.concurrency)
  if (concurrency === 0) return { aborted: options.signal?.aborted ?? false, results: [] }

  const presentation =
    options.presentation?.enabled === true
      ? new ListrConcurrentPresentation(items, concurrency, options.presentation)
      : undefined
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
      notifyStart(options.onStart, item, index)

      let result: ConcurrentRunResult<T, R>
      try {
        const value = await worker(
          item,
          index,
          options.signal,
          presentation?.reporter(index) ?? silentTaskReporter,
        )
        result = { index, item, status: 'fulfilled', value }
      } catch (error: unknown) {
        result = { error, index, item, status: 'rejected' }
      }

      scheduled[index] = result
      presentation?.settle(result)
      notifySettled(options.onSettled, result)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()))

  const results = items.map((item, index): ConcurrentRunResult<T, R> => {
    return scheduled[index] ?? { index, item, status: 'not-run' }
  })
  for (const result of results) presentation?.settle(result)
  await presentation?.finish()

  return { aborted: options.signal?.aborted ?? false, results }
}

interface ListrTaskState {
  readonly completion: Deferred<ConcurrentTaskOutcome>
  bufferedBytes: number
  bufferedOutput: string[]
  latestMessage?: string
  stream?: Writable
  task?: RenderableTask
}

interface RenderableTask {
  output: string
  skip(message?: string): void
  stdout(): Writable
}

class ListrConcurrentPresentation<T, R> {
  readonly #items: readonly T[]
  readonly #listr: Listr
  readonly #options: ConcurrentRunPresentation<T, R>
  readonly #states: ListrTaskState[]
  #finished: Promise<void> | undefined

  constructor(items: readonly T[], concurrency: number, options: ConcurrentRunPresentation<T, R>) {
    this.#items = items
    this.#options = options
    this.#states = items.map(() => ({
      bufferedBytes: 0,
      bufferedOutput: [],
      completion: new Deferred<ConcurrentTaskOutcome>(),
    }))
    const tasks: ListrTask[] = items.map((item, index) => ({
      rendererOptions: { outputBar: true, persistentOutput: false },
      task: async (_context, task): Promise<void> => this.runTask(index, task),
      title: safeTitle(options, item, index),
    }))
    this.#listr = new Listr(tasks, {
      concurrent: concurrency,
      exitOnError: false,
      fallbackRenderer: 'silent',
      registerSignalListeners: false,
      renderer: 'default',
      rendererOptions: {
        collapseErrors: false,
        showErrorMessage: true,
      },
    })
  }

  start(): void {
    if (this.#finished !== undefined) return
    this.#finished = this.#listr.run().then(
      () => undefined,
      () => undefined,
    )
  }

  reporter(index: number): ConcurrentTaskReporter {
    const state = this.#states[index]
    if (state === undefined) return silentTaskReporter
    return {
      enabled: true,
      update: (message): void => updateTaskMessage(state, message),
      write: (chunk): void => writeTaskOutput(state, chunk),
    }
  }

  settle(result: ConcurrentRunResult<T, R>): void {
    const state = this.#states[result.index]
    if (state === undefined || state.completion.settled) return

    if (result.status === 'rejected') {
      state.completion.resolve({ status: 'failed', message: errorMessage(result.error) })
      return
    }
    if (result.status === 'not-run') {
      state.completion.resolve({ status: 'skipped', message: 'not run before interruption' })
      return
    }

    let outcome: ConcurrentTaskOutcome = { status: 'completed' }
    try {
      outcome =
        this.#options.outcome?.(result.value, this.#items[result.index] as T, result.index) ??
        outcome
    } catch {
      // Presentation callbacks must not change the operation result.
    }
    state.completion.resolve(outcome)
  }

  async finish(): Promise<void> {
    await this.#finished
  }

  private async runTask(index: number, task: RenderableTask): Promise<void> {
    const state = this.#states[index]
    if (state === undefined) return
    state.task = task
    if (state.latestMessage !== undefined) task.output = state.latestMessage
    state.stream = task.stdout()
    for (const chunk of state.bufferedOutput) state.stream.write(chunk)
    state.bufferedOutput = []
    state.bufferedBytes = 0

    const outcome = await state.completion.promise
    state.stream.end()
    if (outcome.status === 'failed') throw new Error(displayMessage(outcome.message ?? 'failed'))
    if (outcome.status === 'skipped') {
      task.skip(outcome.message)
      return
    }
    if (outcome.message !== undefined) task.output = outcome.message
  }
}

class Deferred<T> {
  readonly promise: Promise<T>
  #resolve: (value: T) => void = () => undefined
  settled = false

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.#resolve = resolve
    })
  }

  resolve(value: T): void {
    if (this.settled) return
    this.settled = true
    this.#resolve(value)
  }
}

function safeTitle<T, R>(options: ConcurrentRunPresentation<T, R>, item: T, index: number): string {
  try {
    return options.title(item, index)
  } catch {
    return `Task ${index + 1}`
  }
}

function updateTaskMessage(state: ListrTaskState, message: string): void {
  try {
    state.latestMessage = message
    if (state.task !== undefined) state.task.output = message
  } catch {
    // Rendering progress must not interrupt independent work.
  }
}

function writeTaskOutput(state: ListrTaskState, chunk: string): void {
  if (chunk.length === 0) return
  try {
    if (state.stream !== undefined) {
      state.stream.write(chunk)
      return
    }
    const bounded = chunk.slice(-32_768)
    state.bufferedOutput.push(bounded)
    state.bufferedBytes += bounded.length
    while (state.bufferedBytes > 32_768 && state.bufferedOutput.length > 1) {
      state.bufferedBytes -= state.bufferedOutput.shift()?.length ?? 0
    }
  } catch {
    // Child output is supplemental and must not affect the Git operation.
  }
}

function errorMessage(error: unknown): string {
  return displayMessage(error instanceof Error ? error.message : String(error))
}

function displayMessage(message: string): string {
  const lines = message
    .split(/\r?\n|\r/u)
    .map((line) => line.trim())
    .filter(Boolean)
  return (lines.at(-1) ?? 'failed').slice(0, 500)
}

function notifyStart<T>(
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

function notifySettled<T, R>(
  listener: ((result: ConcurrentRunResult<T, R>) => void) | undefined,
  result: ConcurrentRunResult<T, R>,
): void {
  try {
    listener?.(result)
  } catch {
    // Final rendering is likewise outside the worker failure boundary.
  }
}
