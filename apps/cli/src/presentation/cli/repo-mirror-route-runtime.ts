import { GitsError } from '../../domain/task/errors.js'
import type { RepoMirrorCommandOutput } from '../../domain/repo-mirror/model.js'
import { setExitCode } from './command-execution.js'
import type { RouteContext, SuggestedCommand } from './route-runtime.js'
import { formatRepoMirrorOutput } from './presenters/repo-mirror-output.js'

export async function runRepoMirrorRoute(
  context: RouteContext,
  command: string,
  action: (signal: AbortSignal) => Promise<RepoMirrorCommandOutput>,
  options: Readonly<{
    nextCommands?: readonly SuggestedCommand[]
    wide?: boolean
  }> = {},
): Promise<unknown> {
  const controller = new AbortController()
  const interrupt = (): void => controller.abort()
  process.once('SIGINT', interrupt)
  let output: RepoMirrorCommandOutput
  let exitCode = 0
  try {
    output = await action(controller.signal)
    exitCode = output.ok ? 0 : 1
  } catch (error) {
    const known = error instanceof GitsError
    const code = known ? error.code : 'internal-error'
    const message = error instanceof Error ? error.message : String(error)
    exitCode = known ? error.exitCode : controller.signal.aborted ? 130 : 1
    output = { command, mirrors: [], ok: false, warnings: [`${code}: ${message}`] }
    if (context.agent) process.stderr.write(`${code}: ${message}\n`)
  } finally {
    process.removeListener('SIGINT', interrupt)
  }

  setExitCode(exitCode)
  const data =
    context.agent || context.format === 'json'
      ? output
      : formatRepoMirrorOutput(output, options.wide)
  if (context.format === 'json') return data
  return context.ok(data, {
    cta: { commands: [...(options.nextCommands ?? [])] },
  })
}

export async function runRepoMirrorValueRoute<T>(
  context: RouteContext,
  command: string,
  action: () => Promise<T>,
  human: (value: T) => string,
  options: Readonly<{ plain?: boolean }> = {},
): Promise<unknown> {
  try {
    const value = await action()
    setExitCode(0)
    const data =
      context.format === 'json'
        ? { command, ok: true, value }
        : options.plain === true
          ? human(value)
          : context.agent
            ? { command, ok: true, value }
            : human(value)
    if (context.format === 'json') return data
    return context.ok(data)
  } catch (error) {
    const known = error instanceof GitsError
    const code = known ? error.code : 'internal-error'
    const message = error instanceof Error ? error.message : String(error)
    setExitCode(known ? error.exitCode : 1)
    if (context.agent || options.plain === true) process.stderr.write(`${code}: ${message}\n`)
    const data = { command, error: { code, message }, ok: false }
    if (context.format === 'json') return data
    if (options.plain === true) return context.ok('')
    return context.ok(context.agent ? data : `${code}: ${message}`)
  }
}
