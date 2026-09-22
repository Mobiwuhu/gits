import type {
  CommandOutput,
  GitsUninstallOutput,
  RepoMirrorCommandOutput,
  TaskTemplateCommandOutput,
} from '@usegits/core'

import type { SuggestedCommand } from './cliContext'

export interface CliDiagnostic {
  readonly code: string
  readonly message: string
}

export interface CliPresentation<TOutput> {
  readonly exitCode: number
  readonly output: TOutput
}

export interface CommandPresentation extends CliPresentation<CommandOutput> {
  readonly diagnostic?: CliDiagnostic
}

export type RepoMirrorPresentation = CliPresentation<RepoMirrorCommandOutput>

export type UninstallPresentation = CliPresentation<GitsUninstallOutput>

export type TaskTemplatePresentation =
  CliPresentation<TaskTemplateCommandOutput>

export interface TaskTemplatePresentationOptions {
  readonly nextCommands?: readonly SuggestedCommand[]
  readonly wide?: boolean
}

export interface RepoMirrorPresentationOptions {
  readonly nextCommands?: readonly SuggestedCommand[]
  readonly wide?: boolean
}
