import type { Cli } from 'incur'

export type CliInstance = Cli.Cli<any, any, any, any>

export interface SuggestedCommand {
  readonly command: string
  readonly description?: string
}

export interface CliContext {
  readonly agent: boolean
  readonly format: string
  readonly globals: { readonly cwd?: string }
  readonly ok: (
    data: unknown,
    metadata?: {
      readonly cta?: {
        readonly commands: readonly SuggestedCommand[]
      }
    },
  ) => never
}
