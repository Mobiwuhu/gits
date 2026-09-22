import {
  GitsError,
  IncompleteConfigurationError,
  initialRepositoryResult,
} from '@usegits/core'
import type {
  RepositoryCommandResult,
  TaskTemplateCommandName,
} from '@usegits/core'

import { exitCode } from '../contract/index'
import type {
  CommandPresentation,
  ICliErrorService,
  RepoMirrorPresentation,
  TaskTemplatePresentation,
  UninstallPresentation,
} from '../contract/index'

export class CliErrorService implements ICliErrorService {
  command(command: string, error: unknown): CommandPresentation {
    if (error instanceof IncompleteConfigurationError) {
      const repos = error.repositories.map((repository) =>
        incompleteResult(repository, error)
      )
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
        diagnostic: {
          code: 'interrupted',
          message: 'Command interrupted by user.',
        },
        exitCode: exitCode.interrupted,
        output: { command, ok: false, repos: [] },
      }
    }

    const message = errorMessage(error)
    return {
      diagnostic: { code: 'internal-error', message },
      exitCode: exitCode.failure,
      output: { command, ok: false, repos: [] },
    }
  }

  repoMirror(
    command: string,
    error: unknown,
    aborted: boolean
  ): RepoMirrorPresentation {
    const interrupted = aborted || isInterrupted(error)
    const code = failureCode(error, interrupted)
    const message = errorMessage(error)
    return {
      exitCode: failureExitCode(error, interrupted),
      output: {
        command,
        mirrors: [],
        ok: false,
        warnings: [`${code}: ${message}`],
      },
    }
  }

  taskTemplate(
    command: TaskTemplateCommandName,
    error: unknown,
    aborted: boolean
  ): TaskTemplatePresentation {
    const interrupted = aborted || isInterrupted(error)
    const code = failureCode(error, interrupted)
    const message = errorMessage(error)
    return {
      exitCode: failureExitCode(error, interrupted),
      output: {
        command,
        ok: false,
        templates: [],
        warnings: [`${code}: ${message}`],
      },
    }
  }

  uninstall(error: unknown, aborted: boolean): UninstallPresentation {
    const interrupted = aborted || isInterrupted(error)
    const code = failureCode(error, interrupted)
    const message = errorMessage(error)
    return {
      exitCode: failureExitCode(error, interrupted),
      output: {
        command: 'uninstall',
        dryRun: false,
        mirrors: [],
        ok: false,
        removedMirrors: [],
        removedPaths: [],
        targets: [],
        warnings: [`${code}: ${message}`],
      },
    }
  }
}

function incompleteResult(
  repository: IncompleteConfigurationError['repositories'][number],
  error: IncompleteConfigurationError
): RepositoryCommandResult {
  return {
    ...initialRepositoryResult(repository),
    error: { code: error.code, message: error.message },
  }
}

function isInterrupted(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.message.toLowerCase().includes('aborted'))
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failureCode(error: unknown, interrupted: boolean): string {
  if (error instanceof GitsError) {
    return error.code
  }
  if (interrupted) {
    return 'interrupted'
  }
  return 'internal-error'
}

function failureExitCode(error: unknown, interrupted: boolean): number {
  if (error instanceof GitsError) {
    return error.exitCode
  }
  if (interrupted) {
    return exitCode.interrupted
  }
  return exitCode.failure
}
