import { findTaskRoot, resolveWorkingDirectory } from '../../application/task/find-task-root.js'
import { UsageError } from '../../domain/task/errors.js'
import type { CommandOutput } from '../../domain/task/model.js'
import { executeCommand, reportMachineDiagnostic, setExitCode } from './command-execution.js'
import { runInterruptibly } from './interrupt.js'
import { formatCommandOutput, type CommandPresentation } from './presenters/command-output.js'

export interface RouteContext {
  readonly agent: boolean
  readonly format: string
  readonly globals: { readonly cwd?: string }
  readonly ok: (
    data: unknown,
    metadata?: {
      cta?: {
        commands: SuggestedCommand[]
      }
    },
  ) => never
}

export interface SuggestedCommand {
  readonly command: string
  readonly description?: string
}

export async function taskRoot(context: RouteContext): Promise<string> {
  const workingDirectory = await resolveWorkingDirectory(context.globals.cwd)
  return findTaskRoot(workingDirectory)
}

export async function commandRoot(context: RouteContext): Promise<string> {
  return resolveWorkingDirectory(context.globals.cwd)
}

export function parseJobs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/u.test(value)) throw new UsageError('--jobs must be a positive integer.')

  const jobs = Number(value)
  if (!Number.isSafeInteger(jobs) || jobs < 1) {
    throw new UsageError('--jobs must be a positive integer.')
  }
  return jobs
}

export async function runRoute(
  context: RouteContext,
  command: string,
  action: (signal: AbortSignal) => Promise<CommandOutput>,
  nextCommands: SuggestedCommand[],
): Promise<unknown> {
  const presentation = await executeCommand(command, () => runInterruptibly(action))
  return present(context, presentation, nextCommands)
}

function present(
  context: RouteContext,
  presentation: CommandPresentation,
  nextCommands: SuggestedCommand[],
): unknown {
  setExitCode(presentation.exitCode)
  if (context.agent) reportMachineDiagnostic(presentation)

  const data = context.agent ? presentation.output : formatCommandOutput(presentation)
  if (context.format === 'json') return data

  return context.ok(data, { cta: { commands: nextCommands } })
}
