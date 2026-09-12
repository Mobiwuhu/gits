import { spawn } from 'node:child_process'

import type {
  GitCommandResult,
  GitOutputChunk,
} from '../../application/ports/git-repository-gateway.js'

export type {
  GitCommandResult,
  GitOutputChunk,
} from '../../application/ports/git-repository-gateway.js'

export type GitCommandOptions = Readonly<{
  cwd: string
  environment?: NodeJS.ProcessEnv
  interactive?: boolean
  onOutput?: (chunk: GitOutputChunk) => void
  signal?: AbortSignal
  stdio?: 'inherit' | 'interactive-pipe' | 'pipe'
}>

export interface GitCommandRunner {
  run(args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult>
}

export type SystemGitCommandRunnerOptions = Readonly<{
  gitPath?: string
}>

/** Raised only when Node could not start Git, as distinct from a Git exit code. */
export class GitCommandSpawnError extends Error {
  readonly args: readonly string[]
  readonly cwd: string

  constructor(args: readonly string[], cwd: string, cause: Error) {
    super(`Unable to start git ${args.join(' ')} in ${cwd}: ${cause.message}`, { cause })
    this.name = 'GitCommandSpawnError'
    this.args = args
    this.cwd = cwd
  }
}

/**
 * Executes Git without a shell. Non-interactive calls always disable terminal
 * credential prompts so concurrent workers cannot compete for the same TTY.
 */
export class SystemGitCommandRunner implements GitCommandRunner {
  readonly #gitPath: string

  constructor(options: SystemGitCommandRunnerOptions = {}) {
    this.#gitPath = options.gitPath ?? process.env.GITS_GIT_EXECUTABLE ?? 'git'
  }

  async run(args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult> {
    const startedAt = performance.now()
    if (options.signal?.aborted) {
      return createAbortedResult(args, startedAt)
    }

    const useInheritedStdio = options.stdio === 'inherit'
    const useInteractivePipes = options.stdio === 'interactive-pipe'
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.environment,
      ...(options.interactive === true ? {} : { GIT_TERMINAL_PROMPT: '0' }),
    }

    return new Promise<GitCommandResult>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let aborted = false
      let settled = false

      const child = spawn(this.#gitPath, [...args], {
        cwd: options.cwd,
        env: environment,
        shell: false,
        stdio: useInheritedStdio
          ? 'inherit'
          : useInteractivePipes
            ? ['inherit', 'pipe', 'pipe']
            : 'pipe',
        windowsHide: true,
      })

      const abort = (): void => {
        aborted = true
        try {
          child.kill('SIGINT')
        } catch {
          // The process can exit between an abort signal and kill().
        }
      }

      const removeAbortListener = (): void => {
        options.signal?.removeEventListener('abort', abort)
      }

      const settle = (result: GitCommandResult): void => {
        if (settled) return
        settled = true
        removeAbortListener()
        resolve(result)
      }

      options.signal?.addEventListener('abort', abort, { once: true })

      if (!useInheritedStdio) {
        child.stdout?.on('data', (chunk: Buffer | string): void => {
          const text = chunk.toString()
          stdout += text
          notifyOutput(options.onOutput, { stream: 'stdout', text })
        })
        child.stderr?.on('data', (chunk: Buffer | string): void => {
          const text = chunk.toString()
          stderr += text
          notifyOutput(options.onOutput, { stream: 'stderr', text })
          if (useInteractivePipes && options.onOutput === undefined) {
            process.stderr.write(text)
          }
        })
      }

      child.once('error', (cause: Error): void => {
        if (settled) return
        settled = true
        removeAbortListener()
        reject(new GitCommandSpawnError(args, options.cwd, cause))
      })

      child.once('close', (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        settle({
          aborted: aborted || options.signal?.aborted === true,
          args,
          durationMs: performance.now() - startedAt,
          exitCode,
          signal,
          stderr,
          stdout,
        })
      })
    })
  }
}

export function createGitCommandRunner(
  options: SystemGitCommandRunnerOptions = {},
): GitCommandRunner {
  return new SystemGitCommandRunner(options)
}

function createAbortedResult(args: readonly string[], startedAt: number): GitCommandResult {
  return {
    aborted: true,
    args,
    durationMs: performance.now() - startedAt,
    exitCode: null,
    signal: 'SIGINT',
    stderr: '',
    stdout: '',
  }
}

function notifyOutput(
  listener: ((chunk: GitOutputChunk) => void) | undefined,
  chunk: GitOutputChunk,
): void {
  try {
    listener?.(chunk)
  } catch {
    // Output rendering must not change the result of an underlying Git action.
  }
}
