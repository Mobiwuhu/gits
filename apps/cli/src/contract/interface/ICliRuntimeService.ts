import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type { CliContext } from '../types/index'

export interface ICliRuntimeService {
  commandRoot(context: CliContext): Promise<string>
  parseJobs(value: string | undefined): number | undefined
  runInterruptibly<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T>
  taskRoot(context: CliContext): Promise<string>
}

export const ICliRuntimeService: IdentifierDecorator<ICliRuntimeService> =
  createIdentifier<ICliRuntimeService>('cli.runtimeService')
