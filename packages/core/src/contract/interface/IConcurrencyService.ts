import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type {
  ConcurrentRunnerOptions,
  ConcurrentRunSummary,
  ConcurrentWorker,
} from '../types/index'

export interface IConcurrencyService {
  resolve(workCount: number, jobs?: number): number
  run<T, R>(
    items: readonly T[],
    worker: ConcurrentWorker<T, R>,
    options?: ConcurrentRunnerOptions<T, R>,
  ): Promise<ConcurrentRunSummary<T, R>>
}

export const IConcurrencyService: IdentifierDecorator<IConcurrencyService> =
  createIdentifier<IConcurrencyService>('core.concurrencyService')
