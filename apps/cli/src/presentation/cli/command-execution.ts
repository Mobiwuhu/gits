import { GitsError, IncompleteConfigurationError } from '../../domain/task/errors.js'
import {
  initialRepositoryResult,
  type CommandOutput,
  type RepositoryCommandResult,
} from '../../domain/task/model.js'
import type { CommandPresentation } from './presenters/command-output.js'

export async function executeCommand(
  command: string,
  action: () => Promise<CommandOutput>,
): Promise<CommandPresentation> {
  try {
    const output = await action()
    return {
      exitCode: output.ok ? 0 : 1,
      output,
    }
  } catch (error) {
    if (error instanceof IncompleteConfigurationError) {
      const repos = error.repositories.map((repository) => incompleteResult(repository, error))
      return {
        exitCode: error.exitCode,
        output: { command, ok: false, repos },
      }
    }

    if (error instanceof GitsError) {
      return {
        diagnostic: { code: error.code, message: error.message },
        exitCode: error.exitCode,
        output: { command, ok: false, repos: [] },
      }
    }

    if (isInterrupted(error)) {
      return {
        diagnostic: { code: 'interrupted', message: 'Command interrupted by user.' },
        exitCode: 130,
        output: { command, ok: false, repos: [] },
      }
    }

    const message = error instanceof Error ? error.message : String(error)
    return {
      diagnostic: { code: 'internal-error', message },
      exitCode: 1,
      output: { command, ok: false, repos: [] },
    }
  }
}

export function setExitCode(exitCode: number): void {
  process.exitCode = exitCode
}

export function reportMachineDiagnostic(presentation: CommandPresentation): void {
  if (!presentation.diagnostic) return
  process.stderr.write(`${presentation.diagnostic.code}: ${presentation.diagnostic.message}\n`)
}

function incompleteResult(
  repository: IncompleteConfigurationError['repositories'][number],
  error: IncompleteConfigurationError,
): RepositoryCommandResult {
  return {
    ...initialRepositoryResult(repository),
    error: { code: error.code, message: error.message },
  }
}

function isInterrupted(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message.toLowerCase().includes('aborted'))
  )
}
