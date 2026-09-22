import { chmod, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { Inject } from '@wendellhu/redi'

import {
  IFileSystemService,
  IGitsPathService,
  IRepoMirrorWorkerSource,
  RepoMirrorInvocationSource,
  RepoMirrorScheduleState,
} from '../../../contract/index'
import type {
  IStableRunnerInstaller,
  RepoMirrorScheduledInvocation,
  StableRunnerObservation,
} from '../../../contract/index'
import {
  gitsManagedArtifactRegistry,
  gitsSchedulerWorkerEnvironmentVariable,
} from '../../../service/index'
import { errorMessage, hasErrorCode, pathExists } from '../../../util/index'

export const nativeRepoMirrorLogMaximumBytes: number = 1024 * 1024
export const nativeRepoMirrorLogMaximumBackups = 2

export interface StableRunnerInstallerOptions {
  readonly nodeExecutable?: string
}

export class StableRunnerInstaller implements IStableRunnerInstaller {
  readonly #nodeExecutable: string
  #workerSourceContent: Promise<string> | null = null

  constructor(
    @Inject(IGitsPathService) private readonly paths: IGitsPathService,
    @Inject(IFileSystemService) private readonly fileSystem: IFileSystemService,
    @Inject(IRepoMirrorWorkerSource) private readonly workerSource: string,
    options: StableRunnerInstallerOptions = {}
  ) {
    this.#nodeExecutable = resolve(options.nodeExecutable ?? process.execPath)
  }

  async inspect(): Promise<StableRunnerObservation> {
    const path = this.path()
    const workerPath = this.workerPath()
    let workerSource: string
    try {
      workerSource = await this.readWorkerSource()
    } catch (error) {
      return {
        message: errorMessage(error),
        path,
        state: RepoMirrorScheduleState.Unavailable,
        workerPath,
      }
    }

    let runner: string | null
    let worker: string | null
    try {
      const installed = await Promise.all([
        readOptional(path),
        readOptional(workerPath),
      ])
      runner = installed[0] ?? null
      worker = installed[1] ?? null
    } catch (error) {
      return {
        message: errorMessage(error),
        path,
        state: RepoMirrorScheduleState.Unavailable,
        workerPath,
      }
    }
    if (runner === null || worker === null) {
      return {
        message: 'Stable scheduler runner or worker is missing.',
        path,
        state: RepoMirrorScheduleState.Drifted,
        workerPath,
      }
    }
    const expectedRunner = runnerSource(this.#nodeExecutable, workerPath)
    if (runner !== expectedRunner || worker !== workerSource) {
      return {
        message:
          'Stable scheduler runner does not match the current gits installation.',
        path,
        state: RepoMirrorScheduleState.Drifted,
        workerPath,
      }
    }
    try {
      const [runnerMetadata, workerMetadata] = await Promise.all([
        stat(path),
        stat(workerPath),
      ])
      if (
        !runnerMetadata.isFile() ||
        !workerMetadata.isFile() ||
        (runnerMetadata.mode & 0o111) === 0
      ) {
        return {
          message: 'Stable scheduler runner is not an executable file.',
          path,
          state: RepoMirrorScheduleState.Drifted,
          workerPath,
        }
      }
    } catch (error) {
      return {
        message: errorMessage(error),
        path,
        state: RepoMirrorScheduleState.Unavailable,
        workerPath,
      }
    }
    return {
      path,
      state: RepoMirrorScheduleState.Ready,
      workerPath,
    }
  }

  async install(): Promise<string> {
    const path = this.path()
    const workerPath = this.workerPath()
    const workerSource = await this.readWorkerSource()
    if ((await readOptional(workerPath)) !== workerSource) {
      await this.fileSystem.writeFileAtomically(workerPath, workerSource, 0o700)
    } else {
      await chmod(workerPath, 0o700)
    }
    const content = runnerSource(this.#nodeExecutable, workerPath)
    if ((await readOptional(path)) !== content) {
      await this.fileSystem.writeFileAtomically(path, content, 0o700)
    }
    await chmod(path, 0o700)
    return path
  }

  invocation(name: string): RepoMirrorScheduledInvocation {
    const executable = this.path()
    const path = uniquePathEntries([
      dirname(this.#nodeExecutable),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ]).join(':')
    return {
      arguments: [
        'repo-mirrors',
        'fetch',
        name,
        '--source',
        RepoMirrorInvocationSource.Scheduler,
        '--json',
      ],
      environment: {
        GITS_GIT_EXECUTABLE: process.env.GITS_GIT_EXECUTABLE ?? 'git',
        GITS_HOME: this.paths.home,
        GITS_NATIVE_LOG: resolve(this.paths.logs, `${name}.native.log`),
        GIT_TERMINAL_PROMPT: '0',
        HOME: process.env.HOME ?? '',
        PATH: path,
      },
      executable,
    }
  }

  path(): string {
    return resolve(
      this.paths.bin,
      gitsManagedArtifactRegistry.stableSchedulerRunner.fileName
    )
  }

  async refreshIfInstalled(): Promise<boolean> {
    const [runnerExists, workerExists] = await Promise.all([
      pathExists(this.path()),
      pathExists(this.workerPath()),
    ])
    if (!runnerExists && !workerExists) {
      return false
    }
    const observation = await this.inspect()
    if (observation.state !== RepoMirrorScheduleState.Ready) {
      await this.install()
    }
    return true
  }

  private async readWorkerSource(): Promise<string> {
    if (this.#workerSourceContent === null) {
      this.#workerSourceContent = this.loadWorkerSource()
    }
    return this.#workerSourceContent
  }

  private async loadWorkerSource(): Promise<string> {
    const workerSource = resolve(this.workerSource)
    let content: string
    try {
      content = await readFile(workerSource, 'utf-8')
    } catch (error) {
      throw new Error(
        `Cannot read packaged scheduler worker ${workerSource}: ${errorMessage(error)}`,
        { cause: error }
      )
    }
    if (
      !content.includes(
        gitsManagedArtifactRegistry.schedulerWorker.bundleMarker
      )
    ) {
      throw new Error(
        `Packaged scheduler worker ${workerSource} has no gits bundle marker.`
      )
    }
    return content
  }

  private workerPath(): string {
    return resolve(
      this.paths.bin,
      gitsManagedArtifactRegistry.schedulerWorker.fileName
    )
  }
}

function runnerSource(executable: string, workerPath: string): string {
  const prefix = JSON.stringify([workerPath])
  const workerEnvironment = JSON.stringify(
    gitsSchedulerWorkerEnvironmentVariable
  )
  return [
    '#!/usr/bin/env node',
    "'use strict'",
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const { spawn } = require('node:child_process')",
    `const maximumLogBytes = ${nativeRepoMirrorLogMaximumBytes}`,
    `const maximumLogBackups = ${nativeRepoMirrorLogMaximumBackups}`,
    "const truncationMarker = Buffer.from('\\n[gits] native log output truncated\\n')",
    '',
    'function ignoreMissing(error) {',
    "  if (!error || error.code !== 'ENOENT') throw error",
    '}',
    '',
    'function capLogFile(logPath) {',
    '  let metadata',
    '  try { metadata = fs.statSync(logPath) } catch (error) { ignoreMissing(error); return }',
    '  if (metadata.size <= maximumLogBytes) return',
    "  const descriptor = fs.openSync(logPath, 'r')",
    '  const buffer = Buffer.allocUnsafe(maximumLogBytes)',
    '  let offset = 0',
    '  try {',
    '    while (offset < buffer.length) {',
    '      const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, metadata.size - maximumLogBytes + offset)',
    '      if (count === 0) break',
    '      offset += count',
    '    }',
    '  } finally { fs.closeSync(descriptor) }',
    '  fs.writeFileSync(logPath, buffer.subarray(0, offset), { mode: 0o600 })',
    '}',
    '',
    'function rotateLog(logPath) {',
    '  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 })',
    '  let size',
    '  try { size = fs.statSync(logPath).size } catch (error) { ignoreMissing(error); return }',
    '  if (size < maximumLogBytes) return',
    '  fs.rmSync(`${logPath}.${maximumLogBackups}`, { force: true })',
    '  for (let index = maximumLogBackups - 1; index >= 1; index -= 1) {',
    '    try { fs.renameSync(`${logPath}.${index}`, `${logPath}.${index + 1}`) } catch (error) { ignoreMissing(error) }',
    '  }',
    '  fs.renameSync(logPath, `${logPath}.1`)',
    '  for (let index = 1; index <= maximumLogBackups; index += 1) capLogFile(`${logPath}.${index}`)',
    '}',
    '',
    'function openLogSink(logPath) {',
    '  rotateLog(logPath)',
    "  const descriptor = fs.openSync(logPath, 'a', 0o600)",
    '  let closed = false',
    '  let written = Math.min(fs.fstatSync(descriptor).size, maximumLogBytes)',
    '  let truncated = false',
    '  return {',
    '    close() {',
    '      if (closed) return',
    '      closed = true',
    '      fs.closeSync(descriptor)',
    '    },',
    '    write(chunk) {',
    '      if (closed || truncated) return',
    '      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))',
    '      const remaining = Math.max(0, maximumLogBytes - written)',
    '      if (buffer.length <= remaining) {',
    '        fs.writeSync(descriptor, buffer)',
    '        written += buffer.length',
    '        return',
    '      }',
    '      if (remaining >= truncationMarker.length) {',
    '        const contentLength = remaining - truncationMarker.length',
    '        if (contentLength > 0) fs.writeSync(descriptor, buffer.subarray(0, contentLength))',
    '      } else {',
    '        fs.ftruncateSync(descriptor, maximumLogBytes - truncationMarker.length)',
    '      }',
    '      fs.writeSync(descriptor, truncationMarker)',
    '      written = maximumLogBytes',
    '      truncated = true',
    '    },',
    '  }',
    '}',
    '',
    'try {',
    '  const nativeLogPath = process.env.GITS_NATIVE_LOG',
    '  const sink = nativeLogPath ? openLogSink(nativeLogPath) : null',
    `  const childEnvironment = { ...process.env, [${workerEnvironment}]: '1' }`,
    `  const child = spawn(${JSON.stringify(executable)}, ${prefix}.concat(process.argv.slice(2)), { env: childEnvironment, stdio: sink ? ['ignore', 'ignore', 'pipe'] : 'inherit' })`,
    "  if (sink && child.stderr) child.stderr.on('data', (chunk) => sink.write(chunk))",
    "  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {",
    '    process.once(signal, () => {',
    '      if (child.exitCode === null && child.signalCode === null) child.kill(signal)',
    '    })',
    '  }',
    "  child.once('error', (error) => {",
    '    if (sink) sink.write(`[gits] ${error.message}\\n`)',
    '    else console.error(error.message)',
    '  })',
    "  child.once('close', (code, signal) => {",
    '    if (sink) sink.close()',
    '    if (signal) process.kill(process.pid, signal)',
    '    else process.exitCode = code ?? 1',
    '  })',
    '} catch (error) {',
    '  console.error(error instanceof Error ? error.message : String(error))',
    '  process.exitCode = 1',
    '}',
    '',
  ].join('\n')
}

function uniquePathEntries(entries: readonly string[]): readonly string[] {
  return entries.filter(
    (entry, index) => entry.length > 0 && entries.indexOf(entry) === index
  )
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null
    }
    throw error
  }
}
