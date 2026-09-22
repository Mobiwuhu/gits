import type {
  CommandOutput,
  GitsUninstallOutput,
  RepoMirrorCommandOutput,
  TaskTemplateCommandOutput,
  TaskTemplateCommandName,
} from '@usegits/core'
import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type {
  CliCommandOutput,
  CliContext,
  CliValueOutput,
  RepoMirrorPresentationOptions,
  SuggestedCommand,
  TaskTemplatePresentationOptions,
} from '../types/index'

export interface ICliOutputService {
  runCommand(
    context: CliContext<CliCommandOutput<CommandOutput>>,
    command: string,
    action: (signal: AbortSignal) => Promise<CommandOutput>,
    nextCommands: readonly SuggestedCommand[]
  ): Promise<CommandOutput>
  runRepoMirror(
    context: CliContext<CliCommandOutput<RepoMirrorCommandOutput>>,
    command: string,
    action: (signal: AbortSignal) => Promise<RepoMirrorCommandOutput>,
    options?: RepoMirrorPresentationOptions
  ): Promise<RepoMirrorCommandOutput>
  runTaskTemplate(
    context: CliContext<CliCommandOutput<TaskTemplateCommandOutput>>,
    command: TaskTemplateCommandName,
    action: (signal: AbortSignal) => Promise<TaskTemplateCommandOutput>,
    options?: TaskTemplatePresentationOptions
  ): Promise<TaskTemplateCommandOutput>
  runUninstall(
    context: CliContext<CliCommandOutput<GitsUninstallOutput>>,
    action: (signal: AbortSignal) => Promise<GitsUninstallOutput>
  ): Promise<GitsUninstallOutput>
  runValue<T>(
    context: CliContext<CliCommandOutput<CliValueOutput<T>>>,
    command: string,
    action: () => Promise<T>,
    human: (value: T) => string,
    options?: Readonly<{ plain?: boolean }>
  ): Promise<CliValueOutput<T>>
}

export const ICliOutputService: IdentifierDecorator<ICliOutputService> =
  createIdentifier<ICliOutputService>('cli.outputService')
