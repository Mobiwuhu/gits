import type { CommandOutput, GitsUninstallOutput, RepoMirrorCommandOutput } from '@gits/core'
import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type { CliContext, RepoMirrorPresentationOptions, SuggestedCommand } from '../types/index'

export interface ICliOutputService {
  runCommand(
    context: CliContext,
    command: string,
    action: (signal: AbortSignal) => Promise<CommandOutput>,
    nextCommands: readonly SuggestedCommand[],
  ): Promise<unknown>
  runRepoMirror(
    context: CliContext,
    command: string,
    action: (signal: AbortSignal) => Promise<RepoMirrorCommandOutput>,
    options?: RepoMirrorPresentationOptions,
  ): Promise<unknown>
  runUninstall(
    context: CliContext,
    action: (signal: AbortSignal) => Promise<GitsUninstallOutput>,
  ): Promise<unknown>
  runValue<T>(
    context: CliContext,
    command: string,
    action: () => Promise<T>,
    human: (value: T) => string,
    options?: Readonly<{ plain?: boolean }>,
  ): Promise<unknown>
}

export const ICliOutputService: IdentifierDecorator<ICliOutputService> =
  createIdentifier<ICliOutputService>('cli.outputService')
