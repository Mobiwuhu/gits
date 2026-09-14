import type { Writable } from 'node:stream'

import {
  ConcurrentRunStatus,
  ConcurrentTaskOutcomeStatus,
  type ConcurrentPresentation,
  type ConcurrentRunPresentation,
  type ConcurrentRunResult,
  type ConcurrentTaskOutcome,
  type ConcurrentTaskReporter,
  type IConcurrencyPresentationService,
} from '@gits/core'
import { Listr, type ListrTask } from 'listr2'

const silentTaskReporter: ConcurrentTaskReporter = {
  enabled: false,
  update: () => undefined,
  write: () => undefined,
}

export class CliProgressService implements IConcurrencyPresentationService {
  create<T, R>(
    items: readonly T[],
    concurrency: number,
    options: ConcurrentRunPresentation<T, R>,
  ): ConcurrentPresentation<T, R> {
    return new ListrConcurrentPresentation(items, concurrency, options)
  }
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

class ListrConcurrentPresentation<T, R> implements ConcurrentPresentation<T, R> {
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
      task: async (_context, task): Promise<void> => this.#runTask(index, task),
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

    if (result.status === ConcurrentRunStatus.Rejected) {
      state.completion.resolve({
        status: ConcurrentTaskOutcomeStatus.Failed,
        message: errorMessage(result.error),
      })
      return
    }
    if (result.status === ConcurrentRunStatus.NotRun) {
      state.completion.resolve({
        status: ConcurrentTaskOutcomeStatus.Skipped,
        message: 'not run before interruption',
      })
      return
    }

    let outcome: ConcurrentTaskOutcome = { status: ConcurrentTaskOutcomeStatus.Completed }
    try {
      outcome =
        this.#options.outcome?.(result.value, this.#items[result.index] as T, result.index) ??
        outcome
    } catch {
      // Presentation callbacks cannot change the operation result.
    }
    state.completion.resolve(outcome)
  }

  async finish(): Promise<void> {
    await this.#finished
  }

  async #runTask(index: number, task: RenderableTask): Promise<void> {
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
    if (outcome.status === ConcurrentTaskOutcomeStatus.Failed)
      throw new Error(displayMessage(outcome.message ?? 'failed'))
    if (outcome.status === ConcurrentTaskOutcomeStatus.Skipped) {
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
    // Child output is supplemental and must not affect the operation.
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
