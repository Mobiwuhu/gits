import type { GitsUninstallOutput } from '../../application/uninstall/gits-uninstaller.js'
import { GitsError } from '../../domain/task/errors.js'
import { setExitCode } from './command-execution.js'
import { formatUninstallOutput } from './presenters/uninstall-output.js'
import type { RouteContext } from './route-runtime.js'

export async function runUninstallRoute(
  context: RouteContext,
  action: (signal: AbortSignal) => Promise<GitsUninstallOutput>,
): Promise<unknown> {
  const controller = new AbortController()
  const interrupt = (): void => controller.abort()
  process.once('SIGINT', interrupt)
  let output: GitsUninstallOutput
  let exitCode = 0
  try {
    output = await action(controller.signal)
    exitCode = output.ok ? 0 : 1
  } catch (error) {
    const known = error instanceof GitsError
    const code = known ? error.code : controller.signal.aborted ? 'interrupted' : 'internal-error'
    const message = error instanceof Error ? error.message : String(error)
    exitCode = known ? error.exitCode : controller.signal.aborted ? 130 : 1
    output = {
      command: 'uninstall',
      dryRun: false,
      mirrors: [],
      ok: false,
      removedMirrors: [],
      removedPaths: [],
      targets: [],
      warnings: [`${code}: ${message}`],
    }
    if (context.agent) process.stderr.write(`${code}: ${message}\n`)
  } finally {
    process.removeListener('SIGINT', interrupt)
  }

  setExitCode(exitCode)
  const data = context.agent || context.format === 'json' ? output : formatUninstallOutput(output)
  if (context.format === 'json') return data
  return context.ok(data)
}
