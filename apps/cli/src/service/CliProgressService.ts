import type { Writable } from 'node:stream'

import { ConcurrentRunStatus, ConcurrentTaskOutcomeStatus } from '@usegit/core'
import type {
  ConcurrentPresentation,
  ConcurrentRunPresentation,
  ConcurrentRunResult,
  ConcurrentTaskOutcome,
  ConcurrentTaskReporter,
  IConcurrencyPresentationService,
} from '@usegit/core'
import { Listr } from 'listr2'
import type { ListrTask } from 'listr2'

const silentTaskReporter: ConcurrentTaskReporter = {
  enabled: false,
  update: () => {
    /* 无需展示进度 */
  },
  write: () => {
    /* 无需输出任务日志 */
  },
}

export class CliProgressService implements IConcurrencyPresentationService {
  create<T, R>(
    items: readonly T[],
    concurrency: number,
    options: ConcurrentRunPresentation<T, R>
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
  readonly skip: (message?: string) => void
  readonly stdout: () => Writable
}

class ListrConcurrentPresentation<T, R> implements ConcurrentPresentation<
  T,
  R
> {
  readonly #listr: Listr<Record<string, never>, 'default', 'silent'>
  readonly #options: ConcurrentRunPresentation<T, R>
  readonly #states: ListrTaskState[]
  #finished: Promise<void> | undefined

  constructor(
    items: readonly T[],
    concurrency: number,
    options: ConcurrentRunPresentation<T, R>
  ) {
    this.#options = options
    this.#states = items.map(() => ({
      bufferedBytes: 0,
      bufferedOutput: [],
      completion: new Deferred<ConcurrentTaskOutcome>(),
    }))
    const tasks: ListrTask[] = items.map((item, index) => ({
      rendererOptions: { outputBar: true, persistentOutput: false },
      task: async (_context, task): Promise<void> => {
        await this.#runTask(index, task)
      },
      title: safeTitle(options, item, index),
    }))
    this.#listr = new Listr<Record<string, never>, 'default', 'silent'>(tasks, {
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
    if (this.#finished !== undefined) {
      return
    }
    this.#finished = this.#runSilently()
  }

  reporter(index: number): ConcurrentTaskReporter {
    const state = this.#states[index]
    if (state === undefined) {
      return silentTaskReporter
    }
    return {
      enabled: true,
      update: (message): void => {
        updateTaskMessage(state, message)
      },
      write: (chunk): void => {
        writeTaskOutput(state, chunk)
      },
    }
  }

  settle(result: ConcurrentRunResult<T, R>): void {
    const state = this.#states[result.index]
    if (state === undefined || state.completion.settled) {
      return
    }

    if (result.status === ConcurrentRunStatus.Rejected) {
      state.completion.resolve({
        message: errorMessage(result.error),
        status: ConcurrentTaskOutcomeStatus.Failed,
      })
      return
    }
    if (result.status === ConcurrentRunStatus.NotRun) {
      state.completion.resolve({
        message: 'not run before interruption',
        status: ConcurrentTaskOutcomeStatus.Skipped,
      })
      return
    }

    let outcome: ConcurrentTaskOutcome = {
      status: ConcurrentTaskOutcomeStatus.Completed,
    }
    try {
      outcome =
        this.#options.outcome?.(result.value, result.item, result.index) ??
        outcome
    } catch {
      // 展示层回调不能改变实际操作结果。
    }
    state.completion.resolve(outcome)
  }

  async finish(): Promise<void> {
    await this.#finished
  }

  async #runSilently(): Promise<void> {
    try {
      await this.#listr.run()
    } catch {
      // 单个任务的失败会通过 settle 展示，无需让整个渲染器再次抛错。
    }
  }

  async #runTask(index: number, task: RenderableTask): Promise<void> {
    const state = this.#states[index]
    if (state === undefined) {
      return
    }
    state.task = task
    if (state.latestMessage !== undefined) {
      task.output = state.latestMessage
    }
    state.stream = task.stdout()
    for (const chunk of state.bufferedOutput) {
      state.stream.write(chunk)
    }
    state.bufferedOutput = []
    state.bufferedBytes = 0

    const outcome = await state.completion.promise
    state.stream.end()
    if (outcome.status === ConcurrentTaskOutcomeStatus.Failed) {
      throw new Error(displayMessage(outcome.message ?? 'failed'))
    }
    if (outcome.status === ConcurrentTaskOutcomeStatus.Skipped) {
      task.skip(outcome.message)
      return
    }
    if (outcome.message !== undefined) {
      task.output = outcome.message
    }
  }
}

class Deferred<T> {
  readonly promise: Promise<T>
  #resolve: (value: T) => void = () => {
    /* 初始化时无需操作 */
  }
  settled = false

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.#resolve = resolve
    })
  }

  resolve(value: T): void {
    if (this.settled) {
      return
    }
    this.settled = true
    this.#resolve(value)
  }
}

function safeTitle<T>(
  options: Readonly<{ title: (item: T, index: number) => string }>,
  item: T,
  index: number
): string {
  try {
    return options.title(item, index)
  } catch {
    return `Task ${index + 1}`
  }
}

function updateTaskMessage(state: ListrTaskState, message: string): void {
  try {
    state.latestMessage = message
    if (state.task !== undefined) {
      state.task.output = message
    }
  } catch {
    // 进度渲染不能中断彼此独立的任务。
  }
}

function writeTaskOutput(state: ListrTaskState, chunk: string): void {
  if (chunk.length === 0) {
    return
  }
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
    // 子任务输出属于附加信息，不能影响实际操作。
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
