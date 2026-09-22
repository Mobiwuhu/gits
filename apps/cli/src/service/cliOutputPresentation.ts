import type { CliPresentation, SuggestedCommand } from '../contract/index'

export interface PresentedCommandOptions<TOutput> {
  readonly agentError?: (output: TOutput) => string | undefined
  readonly error: (error: unknown) => CliPresentation<TOutput>
  readonly errorSuggestions?: (
    error: unknown,
    fallback: readonly SuggestedCommand[]
  ) => readonly SuggestedCommand[]
  readonly format: (output: TOutput) => string
  readonly nextCommands?: readonly SuggestedCommand[]
  readonly withCta?: boolean
}
