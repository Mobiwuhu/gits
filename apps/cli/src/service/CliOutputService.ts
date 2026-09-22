import { GitsError } from '@usegits/core'
import type {
  CommandOutput,
  GitsUninstallOutput,
  RepoMirrorCommandOutput,
  TaskTemplateCommandOutput,
  TaskTemplateCommandName,
} from '@usegits/core'
import { Inject } from '@wendellhu/redi'

import {
  exitCode,
  ICliErrorService,
  ICliRuntimeService,
} from '../contract/index'
import type {
  CliCommandOutput,
  CliContext,
  CliPresentation,
  CliValueOutput,
  CommandPresentation,
  ICliOutputService,
  RepoMirrorPresentationOptions,
  SuggestedCommand,
  TaskTemplatePresentationOptions,
} from '../contract/index'
import type { PresentedCommandOptions } from './cliOutputPresentation'
import { formatCommandOutput } from './commandOutput'
import { formatRepoMirrorOutput } from './repoMirrorOutput'
import { formatTaskTemplateOutput } from './taskTemplateOutput'
import { formatUninstallOutput } from './uninstallOutput'

export class CliOutputService implements ICliOutputService {
  constructor(
    @Inject(ICliErrorService) private readonly errors: ICliErrorService,
    @Inject(ICliRuntimeService) private readonly runtime: ICliRuntimeService
  ) {}

  async runCommand(
    context: CliContext<CliCommandOutput<CommandOutput>>,
    command: string,
    action: (signal: AbortSignal) => Promise<CommandOutput>,
    nextCommands: readonly SuggestedCommand[]
  ): Promise<CommandOutput> {
    let presentation: CommandPresentation
    let suggestions = nextCommands
    try {
      const output = await this.runtime.runInterruptibly(action)
      presentation = {
        exitCode: output.ok ? exitCode.success : exitCode.failure,
        output,
      }
    } catch (error) {
      presentation = this.errors.command(command, error)
      suggestions = commandErrorSuggestions(error, nextCommands)
    }

    process.exitCode = presentation.exitCode
    if (context.agent && presentation.diagnostic !== undefined) {
      process.stderr.write(
        `${presentation.diagnostic.code}: ${presentation.diagnostic.message}\n`
      )
    }
    if (context.format === 'json') {
      return presentation.output
    }
    const data = context.agent
      ? presentation.output
      : formatCommandOutput(presentation)
    return context.ok(data, { cta: { commands: [...suggestions] } })
  }

  async runRepoMirror(
    context: CliContext<CliCommandOutput<RepoMirrorCommandOutput>>,
    command: string,
    action: (signal: AbortSignal) => Promise<RepoMirrorCommandOutput>,
    options: RepoMirrorPresentationOptions = {}
  ): Promise<RepoMirrorCommandOutput> {
    return this.runPresentedCommand(context, action, {
      agentError: (output) => output.warnings?.[0],
      error: (error) => this.errors.repoMirror(command, error, false),
      format: (output) => formatRepoMirrorOutput(output, options.wide),
      nextCommands: options.nextCommands ?? [],
      withCta: true,
    })
  }

  async runUninstall(
    context: CliContext<CliCommandOutput<GitsUninstallOutput>>,
    action: (signal: AbortSignal) => Promise<GitsUninstallOutput>
  ): Promise<GitsUninstallOutput> {
    return this.runPresentedCommand(context, action, {
      agentError: (output) => output.warnings[0],
      error: (error) => this.errors.uninstall(error, false),
      format: formatUninstallOutput,
    })
  }

  async runTaskTemplate(
    context: CliContext<CliCommandOutput<TaskTemplateCommandOutput>>,
    command: TaskTemplateCommandName,
    action: (signal: AbortSignal) => Promise<TaskTemplateCommandOutput>,
    options: TaskTemplatePresentationOptions = {}
  ): Promise<TaskTemplateCommandOutput> {
    return this.runPresentedCommand(context, action, {
      agentError: (output) => output.warnings?.[0],
      error: (error) => this.errors.taskTemplate(command, error, false),
      errorSuggestions: taskTemplateErrorSuggestions,
      format: (output) => formatTaskTemplateOutput(output, options.wide),
      nextCommands: options.nextCommands ?? [],
      withCta: true,
    })
  }

  async runValue<T>(
    context: CliContext<CliCommandOutput<CliValueOutput<T>>>,
    command: string,
    action: () => Promise<T>,
    human: (value: T) => string,
    options: Readonly<{ plain?: boolean }> = {}
  ): Promise<CliValueOutput<T>> {
    try {
      const value = await action()
      process.exitCode = exitCode.success
      const structured: CliValueOutput<T> = { command, ok: true, value }
      if (context.format === 'json') {
        return structured
      }
      const data =
        context.agent && options.plain !== true ? structured : human(value)
      return context.ok(data)
    } catch (error) {
      const known = error instanceof GitsError
      const code = known ? error.code : 'internal-error'
      const message = error instanceof Error ? error.message : String(error)
      process.exitCode = known ? error.exitCode : exitCode.failure
      if (context.agent || options.plain === true) {
        process.stderr.write(`${code}: ${message}\n`)
      }
      const data: CliValueOutput<T> = {
        command,
        error: { code, message },
        ok: false,
      }
      if (context.format === 'json') {
        return data
      }
      if (options.plain === true) {
        return context.ok('')
      }
      return context.ok(context.agent ? data : `${code}: ${message}`)
    }
  }

  private async runPresentedCommand<TOutput extends { readonly ok: boolean }>(
    context: CliContext<CliCommandOutput<TOutput>>,
    action: (signal: AbortSignal) => Promise<TOutput>,
    options: PresentedCommandOptions<TOutput>
  ): Promise<TOutput> {
    let presentation: CliPresentation<TOutput>
    let suggestions = options.nextCommands ?? []
    try {
      const output = await this.runtime.runInterruptibly(action)
      presentation = {
        exitCode: output.ok ? exitCode.success : exitCode.failure,
        output,
      }
    } catch (error) {
      presentation = options.error(error)
      suggestions =
        options.errorSuggestions?.(error, suggestions) ?? suggestions
      if (context.agent && options.agentError !== undefined) {
        process.stderr.write(
          `${options.agentError(presentation.output) ?? ''}\n`
        )
      }
    }

    process.exitCode = presentation.exitCode
    if (context.format === 'json') {
      return presentation.output
    }
    const data = context.agent
      ? presentation.output
      : options.format(presentation.output)
    if (options.withCta === true) {
      return context.ok(data, { cta: { commands: [...suggestions] } })
    }
    return context.ok(data)
  }
}

function commandErrorSuggestions(
  error: unknown,
  fallback: readonly SuggestedCommand[]
): readonly SuggestedCommand[] {
  if (!(error instanceof GitsError)) {
    return fallback
  }
  if (error.code === 'template-not-found') {
    return [
      {
        command: 'template list',
        description: 'List available task templates',
      },
    ]
  }
  if (error.code === 'template-integrity-failed') {
    return [
      {
        command: 'template list --wide',
        description: 'Inspect unhealthy task templates',
      },
    ]
  }
  return fallback
}

function taskTemplateErrorSuggestions(
  error: unknown,
  fallback: readonly SuggestedCommand[]
): readonly SuggestedCommand[] {
  if (!(error instanceof GitsError)) {
    return fallback
  }
  if (error.code === 'template-already-exists') {
    return [
      {
        command: 'template update',
        description: 'Replace the existing template from a source directory',
      },
    ]
  }
  if (error.code === 'template-not-found') {
    return [
      {
        command: 'template add',
        description: 'Save a source directory as a new template',
      },
      {
        command: 'template list',
        description: 'List available task templates',
      },
    ]
  }
  if (error.code === 'template-integrity-failed') {
    return [
      {
        command: 'template list --wide',
        description: 'Inspect unhealthy task templates',
      },
      {
        command: 'template update',
        description: 'Replace the damaged template from a complete source',
      },
    ]
  }
  return fallback
}
