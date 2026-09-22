import { z } from 'incur'
import type { Cli, Formatter } from 'incur'

export const cliGlobalsSchema: z.ZodObject<{
  cwd: z.ZodOptional<z.ZodString>
}> = z.object({
  cwd: z.string().optional().describe('Run as if started in this directory'),
})

export type CliInstance = Cli.Cli<
  {},
  undefined,
  undefined,
  typeof cliGlobalsSchema
>

export interface SuggestedCommand {
  readonly command: string
  readonly description?: string
}

export interface CliContext<TOutput = never> {
  readonly agent: boolean
  readonly format: Formatter.Format
  readonly globals: z.output<typeof cliGlobalsSchema>
  readonly ok: (
    data: TOutput,
    metadata?: {
      readonly cta?: {
        readonly commands: SuggestedCommand[]
      }
    }
  ) => never
}
