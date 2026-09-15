import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type {
  ConcurrentPresentation,
  ConcurrentRunPresentation,
} from '../types/index'

export interface IConcurrencyPresentationService {
  create<T, R>(
    items: readonly T[],
    concurrency: number,
    options: ConcurrentRunPresentation<T, R>
  ): ConcurrentPresentation<T, R>
}

export const IConcurrencyPresentationService: IdentifierDecorator<IConcurrencyPresentationService> =
  createIdentifier<IConcurrencyPresentationService>(
    'core.concurrencyPresentationService'
  )
