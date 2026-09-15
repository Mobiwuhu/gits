import { chmod } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { Inject } from '@wendellhu/redi'

import {
  IFileSystemService,
  IGitsPathService,
  RepoMirrorInvocationSource,
} from '../../../contract/index'
import type {
  IStableRunnerInstaller,
  RepoMirrorScheduledInvocation,
} from '../../../contract/index'
import { gitsManagedArtifactRegistry } from '../../../service/index'

export const nativeRepoMirrorLogMaximumBytes: number = 1024 * 1024
export const nativeRepoMirrorLogMaximumBackups = 2

export class StableRunnerInstaller implements IStableRunnerInstaller {
  readonly #cliEntry: string
  readonly #nodeArguments: readonly string[]

  constructor(
    @Inject(IGitsPathService) private readonly paths: IGitsPathService,
    @Inject(IFileSystemService) private readonly fileSystem: IFileSystemService,
    cliEntry: string = process.argv[1] ?? '',
    nodeArguments: readonly string[] = schedulerNodeArguments(process.execArgv)
  ) {
    this.#cliEntry = resolve(cliEntry)
    this.#nodeArguments = nodeArguments
  }

  async install(): Promise<string> {
    const path = this.path()
    const content = `#!${process.execPath}\n${runnerSource(process.execPath, this.#nodeArguments, this.#cliEntry)}`
    await this.fileSystem.writeFileAtomically(path, content, 0o700)
    await chmod(path, 0o700)
    return path
  }

  invocation(name: string): RepoMirrorScheduledInvocation {
    const executable = this.path()
    const path = uniquePathEntries([
      dirname(process.execPath),
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
}

function runnerSource(
  executable: string,
  nodeArguments: readonly string[],
  cliEntry: string
): string {
  const prefix = JSON.stringify([...nodeArguments, cliEntry])
  return [
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
    `  const child = spawn(${JSON.stringify(executable)}, ${prefix}.concat(process.argv.slice(2)), { env: process.env, stdio: sink ? ['ignore', 'ignore', 'pipe'] : 'inherit' })`,
    "  if (sink && child.stderr) child.stderr.on('data', (chunk) => sink.write(chunk))",
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

function schedulerNodeArguments(
  arguments_: readonly string[]
): readonly string[] {
  const kept: string[] = []
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === undefined) {
      continue
    }
    if (argument.startsWith('--import=') || argument.startsWith('--loader=')) {
      kept.push(argument)
    } else if (argument === '--import' || argument === '--loader') {
      const value = arguments_[index + 1]
      if (value !== undefined) {
        kept.push(argument, value)
      }
      index += 1
    }
  }
  return kept
}

function uniquePathEntries(entries: readonly string[]): readonly string[] {
  return entries.filter(
    (entry, index) => entry.length > 0 && entries.indexOf(entry) === index
  )
}
