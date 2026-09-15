import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

export interface ProcessResult {
  readonly args: readonly string[]
  readonly durationMs: number
  readonly exitCode: number | null
  readonly stderr: string
  readonly stdout: string
}

export interface IProcessService {
  run(
    executable: string,
    args: readonly string[],
    options?: Readonly<{
      environment?: NodeJS.ProcessEnv
      signal?: AbortSignal
    }>
  ): Promise<ProcessResult>
}

export const IProcessService: IdentifierDecorator<IProcessService> =
  createIdentifier<IProcessService>('core.processService')
