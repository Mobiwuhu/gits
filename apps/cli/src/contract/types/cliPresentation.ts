import type {
  CommandOutput,
  GitsUninstallOutput,
  RepoMirrorCommandOutput,
} from '@usegits/core'

import type { SuggestedCommand } from './cliContext'

export interface CliDiagnostic {
  readonly code: string
  readonly message: string
}

export interface CommandPresentation {
  readonly diagnostic?: CliDiagnostic
  readonly exitCode: number
  readonly output: CommandOutput
}

export interface RepoMirrorPresentation {
  readonly exitCode: number
  readonly output: RepoMirrorCommandOutput
}

export interface UninstallPresentation {
  readonly exitCode: number
  readonly output: GitsUninstallOutput
}

export interface RepoMirrorPresentationOptions {
  readonly nextCommands?: readonly SuggestedCommand[]
  readonly wide?: boolean
}
