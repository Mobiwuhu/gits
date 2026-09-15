import { spawn } from 'node:child_process'

import type { IProcessService, ProcessResult } from '../contract/index'

export class ProcessService implements IProcessService {
  async run(
    executable: string,
    args: readonly string[],
    options: Readonly<{
      environment?: NodeJS.ProcessEnv
      signal?: AbortSignal
    }> = {}
  ): Promise<ProcessResult> {
    const startedAt = performance.now()
    return new Promise<ProcessResult>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      const child = spawn(executable, [...args], {
        env: { ...process.env, ...options.environment },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const abort = (): void => {
        try {
          child.kill('SIGINT')
        } catch {
          // 子进程可能已经退出。
        }
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', (chunk: Buffer | string): void => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer | string): void => {
        stderr += chunk.toString()
      })
      child.once('error', (error) => {
        options.signal?.removeEventListener('abort', abort)
        reject(error)
      })
      child.once('close', (exitCode) => {
        options.signal?.removeEventListener('abort', abort)
        resolve({
          args,
          durationMs: performance.now() - startedAt,
          exitCode,
          stderr,
          stdout,
        })
      })
    })
  }
}
