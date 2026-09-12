import { spawn } from 'node:child_process'

export interface SystemCommandResult {
  readonly args: readonly string[]
  readonly durationMs: number
  readonly exitCode: number | null
  readonly stderr: string
  readonly stdout: string
}

export interface SystemCommandRunner {
  run(
    executable: string,
    args: readonly string[],
    options?: Readonly<{ environment?: NodeJS.ProcessEnv; signal?: AbortSignal }>,
  ): Promise<SystemCommandResult>
}

export class NodeSystemCommandRunner implements SystemCommandRunner {
  async run(
    executable: string,
    args: readonly string[],
    options: Readonly<{ environment?: NodeJS.ProcessEnv; signal?: AbortSignal }> = {},
  ): Promise<SystemCommandResult> {
    const startedAt = performance.now()
    return new Promise<SystemCommandResult>((resolve, reject) => {
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
          // The child may already have exited.
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
