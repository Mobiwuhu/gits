import { GitsError } from '@gits/core'
import type {
  CommandOutput,
  GitsUninstallOutput,
  RepoMirrorCommandOutput,
} from '@gits/core'
import { Inject } from '@wendellhu/redi'

import {
  exitCode,
  ICliErrorService,
  ICliRuntimeService,
} from '../contract/index'
import type {
  CliContext,
  CommandPresentation,
  ICliOutputService,
  RepoMirrorPresentationOptions,
  RepoMirrorPresentation,
  SuggestedCommand,
  UninstallPresentation,
} from '../contract/index'
import { formatCommandOutput } from './commandOutput'
import { formatRepoMirrorOutput } from './repoMirrorOutput'
import { formatUninstallOutput } from './uninstallOutput'

export class CliOutputService implements ICliOutputService {
  constructor(
    @Inject(ICliErrorService) private readonly errors: ICliErrorService,
    @Inject(ICliRuntimeService) private readonly runtime: ICliRuntimeService
  ) {}

  async runCommand(
    context: CliContext,
    command: string,
    action: (signal: AbortSignal) => Promise<CommandOutput>,
    nextCommands: readonly SuggestedCommand[]
  ): Promise<unknown> {
    let presentation: CommandPresentation
    try {
      const output = await this.runtime.runInterruptibly(action)
      presentation = {
        exitCode: output.ok ? exitCode.success : exitCode.failure,
        output,
      }
    } catch (error) {
      presentation = this.errors.command(command, error)
    }

    process.exitCode = presentation.exitCode
    if (context.agent && presentation.diagnostic !== undefined) {
      process.stderr.write(
        `${presentation.diagnostic.code}: ${presentation.diagnostic.message}\n`
      )
    }
    const data = context.agent
      ? presentation.output
      : formatCommandOutput(presentation)
    if (context.format === 'json') {
      return data
    }
    return context.ok(data, { cta: { commands: nextCommands } })
  }

  async runRepoMirror(
    context: CliContext,
    command: string,
    action: (signal: AbortSignal) => Promise<RepoMirrorCommandOutput>,
    options: RepoMirrorPresentationOptions = {}
  ): Promise<unknown> {
    let presentation: RepoMirrorPresentation
    try {
      const output = await this.runtime.runInterruptibly(action)
      presentation = {
        exitCode: output.ok ? exitCode.success : exitCode.failure,
        output,
      }
    } catch (error) {
      presentation = this.errors.repoMirror(command, error, false)
      if (context.agent) {
        process.stderr.write(`${presentation.output.warnings?.[0] ?? ''}\n`)
      }
    }

    process.exitCode = presentation.exitCode
    const data =
      context.agent || context.format === 'json'
        ? presentation.output
        : formatRepoMirrorOutput(presentation.output, options.wide)
    if (context.format === 'json') {
      return data
    }
    return context.ok(data, {
      cta: { commands: [...(options.nextCommands ?? [])] },
    })
  }

  async runUninstall(
    context: CliContext,
    action: (signal: AbortSignal) => Promise<GitsUninstallOutput>
  ): Promise<unknown> {
    let presentation: UninstallPresentation
    try {
      const output = await this.runtime.runInterruptibly(action)
      presentation = {
        exitCode: output.ok ? exitCode.success : exitCode.failure,
        output,
      }
    } catch (error) {
      presentation = this.errors.uninstall(error, false)
      if (context.agent) {
        process.stderr.write(`${presentation.output.warnings[0] ?? ''}\n`)
      }
    }

    process.exitCode = presentation.exitCode
    const data =
      context.agent || context.format === 'json'
        ? presentation.output
        : formatUninstallOutput(presentation.output)
    if (context.format === 'json') {
      return data
    }
    return context.ok(data)
  }

  async runValue<T>(
    context: CliContext,
    command: string,
    action: () => Promise<T>,
    human: (value: T) => string,
    options: Readonly<{ plain?: boolean }> = {}
  ): Promise<unknown> {
    try {
      const value = await action()
      process.exitCode = exitCode.success
      const structured = { command, ok: true, value }
      let data: unknown = human(value)
      if (context.agent) {
        data = structured
      }
      if (options.plain === true) {
        data = human(value)
      }
      if (context.format === 'json') {
        data = structured
      }
      if (context.format === 'json') {
        return data
      }
      return context.ok(data)
    } catch (error) {
      const known = error instanceof GitsError
      const code = known ? error.code : 'internal-error'
      const message = error instanceof Error ? error.message : String(error)
      process.exitCode = known ? error.exitCode : exitCode.failure
      if (context.agent || options.plain === true) {
        process.stderr.write(`${code}: ${message}\n`)
      }
      const data = { command, error: { code, message }, ok: false }
      if (context.format === 'json') {
        return data
      }
      if (options.plain === true) {
        return context.ok('')
      }
      return context.ok(context.agent ? data : `${code}: ${message}`)
    }
  }
}
