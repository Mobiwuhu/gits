import type {
  ConcurrentRunStatus,
  ConcurrentTaskOutcomeStatus,
} from '../constants/concurrency'

export type ConcurrentRunResult<T, R> =
  | Readonly<{
      index: number
      item: T
      status: ConcurrentRunStatus.Fulfilled
      value: R
    }>
  | Readonly<{
      error: unknown
      index: number
      item: T
      status: ConcurrentRunStatus.Rejected
    }>
  | Readonly<{
      index: number
      item: T
      status: ConcurrentRunStatus.NotRun
    }>

export type ConcurrentRunSummary<T, R> = Readonly<{
  aborted: boolean
  results: readonly ConcurrentRunResult<T, R>[]
}>

export interface ConcurrentTaskReporter {
  readonly enabled: boolean
  readonly update: (message: string) => void
  readonly write: (chunk: string) => void
}

export type ConcurrentWorker<T, R> = (
  item: T,
  index: number,
  signal: AbortSignal | undefined,
  task: ConcurrentTaskReporter
) => Promise<R>

export type ConcurrentTaskOutcome = Readonly<{
  message?: string
  status: ConcurrentTaskOutcomeStatus
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

export interface ConcurrentPresentation<T, R> {
  finish(): Promise<void>
  reporter(index: number): ConcurrentTaskReporter
  settle(result: ConcurrentRunResult<T, R>): void
  start(): void
}
