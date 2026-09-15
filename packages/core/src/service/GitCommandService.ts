import { spawn } from 'node:child_process'
import type { StdioOptions } from 'node:child_process'

import { GitOutputStream, GitStdioMode } from '../contract/index'
import type {
  GitCommandOptions,
  GitCommandResult,
  GitOutputChunk,
  IGitCommandService,
} from '../contract/index'

export type {
  GitCommandOptions,
  GitCommandResult,
  GitOutputChunk,
} from '../contract/index'

export type SystemGitCommandRunnerOptions = Readonly<{
  gitPath?: string
}>

/** 仅在 Node 无法启动 Git 时抛出，用于区别 Git 自身返回的退出码。 */
export class GitCommandSpawnError extends Error {
  readonly args: readonly string[]
  readonly cwd: string

  constructor(args: readonly string[], cwd: string, cause: Error) {
    super(`Unable to start git ${args.join(' ')} in ${cwd}: ${cause.message}`, {
      cause,
    })
    this.name = 'GitCommandSpawnError'
    this.args = args
    this.cwd = cwd
  }
}

/**
 * 不经过 Shell 执行 Git。非交互调用会关闭终端凭证提示，避免并发任务争用同一个
 * TTY。
 */
export class GitCommandService implements IGitCommandService {
  readonly #gitPath: string

  constructor(options: SystemGitCommandRunnerOptions = {}) {
    this.#gitPath = options.gitPath ?? process.env.GITS_GIT_EXECUTABLE ?? 'git'
  }

  async run(
    args: readonly string[],
    options: GitCommandOptions
  ): Promise<GitCommandResult> {
    const startedAt = performance.now()
    if (options.signal?.aborted === true) {
      return createAbortedResult(args, startedAt)
    }

    const useInheritedStdio = options.stdio === GitStdioMode.Inherit
    const useInteractivePipes = options.stdio === GitStdioMode.InteractivePipe
    let stdio: StdioOptions = 'pipe'
    if (useInheritedStdio) {
      stdio = 'inherit'
    }
    if (useInteractivePipes) {
      stdio = ['inherit', 'pipe', 'pipe']
    }
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
        stdio,
        windowsHide: true,
      })

      const abort = (): void => {
        aborted = true
        try {
          child.kill('SIGINT')
        } catch {
          // 进程可能在收到中断信号后、调用 kill() 前已经退出。
        }
      }

      const removeAbortListener = (): void => {
        options.signal?.removeEventListener('abort', abort)
      }

      const settle = (result: GitCommandResult): void => {
        if (settled) {
          return
        }
        settled = true
        removeAbortListener()
        resolve(result)
      }

      options.signal?.addEventListener('abort', abort, { once: true })

      if (!useInheritedStdio) {
        child.stdout?.on('data', (chunk: Buffer | string): void => {
          const text = chunk.toString()
          stdout += text
          notifyOutput(options.onOutput, {
            stream: GitOutputStream.Stdout,
            text,
          })
        })
        child.stderr?.on('data', (chunk: Buffer | string): void => {
          const text = chunk.toString()
          stderr += text
          notifyOutput(options.onOutput, {
            stream: GitOutputStream.Stderr,
            text,
          })
          if (useInteractivePipes && options.onOutput === undefined) {
            process.stderr.write(text)
          }
        })
      }

      child.once('error', (cause: Error): void => {
        if (settled) {
          return
        }
        settled = true
        removeAbortListener()
        reject(new GitCommandSpawnError(args, options.cwd, cause))
      })

      child.once(
        'close',
        (exitCode: number | null, signal: NodeJS.Signals | null): void => {
          settle({
            aborted: aborted || options.signal?.aborted === true,
            args,
            durationMs: performance.now() - startedAt,
            exitCode,
            signal,
            stderr,
            stdout,
          })
        }
      )
    })
  }
}

function createAbortedResult(
  args: readonly string[],
  startedAt: number
): GitCommandResult {
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
  chunk: GitOutputChunk
): void {
  try {
    listener?.(chunk)
  } catch {
    // 输出渲染不能改变底层 Git 操作的结果。
  }
}
