import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'

import { parse } from 'plist'

import type { IProcessService, ProcessResult } from '../../../contract/index'
import {
  FileSystemService,
  gitsManagedArtifactRegistry,
  GitsPathService,
} from '../../../service/index'
import { compileCalendarEntries } from './portableCron'
import { RepoMirrorSchedulerService } from './RepoMirrorSchedulerService'
import {
  nativeRepoMirrorLogMaximumBackups,
  nativeRepoMirrorLogMaximumBytes,
  StableRunnerInstaller,
} from './StableRunnerInstaller'

const executeFile = promisify(execFile)

class SuccessfulCommandRunner implements IProcessService {
  readonly calls: {
    readonly args: readonly string[]
    readonly executable: string
  }[] = []

  async run(
    executable: string,
    args: readonly string[]
  ): Promise<ProcessResult> {
    this.calls.push({ args, executable })
    return { args, durationMs: 1, exitCode: 0, stderr: '', stdout: '' }
  }
}

void describe('native repo mirror scheduler', () => {
  void it('preserves cron OR semantics for constrained day-of-month and weekday', () => {
    const entries = compileCalendarEntries('0 1 2 * 3')
    assert.deepEqual(entries, [
      { day: 2, hour: 1, minute: 0 },
      { hour: 1, minute: 0, weekday: 3 },
    ])
  })

  void it('rejects cron expressions that would create too many native calendar entries', () => {
    assert.throws(
      () => compileCalendarEntries('0,10,20,30,40,50 0-23 * 1-12 *'),
      /more than 256 native calendar entries/u
    )
  })

  void it('writes and loads a launchd projection through argv-only commands', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-launchd-test-'))
    try {
      const gitsHome = resolve(root, 'gits-home')
      const userHome = resolve(root, 'user-home')
      const paths = new GitsPathService({
        environment: { GITS_HOME: gitsHome },
        userHome,
      })
      const fileSystem = new FileSystemService()
      const runner = new SuccessfulCommandRunner()
      const workerSource = await createWorkerSource(root)
      const stableRunner = new StableRunnerInstaller(
        paths,
        fileSystem,
        workerSource
      )
      const scheduler = new RepoMirrorSchedulerService(
        paths,
        runner,
        stableRunner,
        fileSystem,
        {
          platformInfo: { platform: 'darwin', uid: 501 },
          userHome,
        }
      )
      const observation = await scheduler.apply({
        name: 'api',
        schedule: { cron: '17 1-23/6 * * *' },
        urls: ['https://example.com/api.git'],
      })
      assert.equal(observation.state, 'ready')
      const { projectionPath } = observation
      assert.ok(projectionPath !== null)
      const plist = parse(await readFile(projectionPath, 'utf-8')) as Record<
        string,
        unknown
      >
      assert.equal(plist.Label, observation.nativeJob)
      assert.deepEqual((plist.ProgramArguments as string[]).slice(-6), [
        'repo-mirrors',
        'fetch',
        'api',
        '--source',
        'scheduler',
        '--json',
      ])
      assert.equal(
        (plist.EnvironmentVariables as Record<string, string>).GITS_NATIVE_LOG,
        resolve(paths.logs, 'api.native.log')
      )
      assert.ok(
        runner.calls.some((call) => call.executable === '/usr/bin/plutil')
      )
      assert.ok(
        runner.calls.some(
          (call) =>
            call.executable === '/bin/launchctl' && call.args[0] === 'bootstrap'
        )
      )
      const inspected = await scheduler.inspect({
        name: 'api',
        schedule: { cron: '17 1-23/6 * * *' },
        urls: ['https://example.com/api.git'],
      })
      assert.equal(inspected.state, 'ready')
      await writeFile(
        resolve(
          paths.bin,
          gitsManagedArtifactRegistry.schedulerWorker.fileName
        ),
        'tampered\n'
      )
      const drifted = await scheduler.inspect({
        name: 'api',
        schedule: { cron: '17 1-23/6 * * *' },
        urls: ['https://example.com/api.git'],
      })
      assert.equal(drifted.state, 'drifted')
      assert.match(drifted.message ?? '', /current gits installation/u)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('writes systemd user service and timer projections', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-systemd-test-'))
    try {
      const gitsHome = resolve(root, 'gits-home')
      const userHome = resolve(root, 'user-home')
      const xdgConfig = resolve(root, 'xdg')
      const environment = { GITS_HOME: gitsHome, XDG_CONFIG_HOME: xdgConfig }
      const paths = new GitsPathService({ environment, userHome })
      const fileSystem = new FileSystemService()
      const runner = new SuccessfulCommandRunner()
      const workerSource = await createWorkerSource(root)
      const stableRunner = new StableRunnerInstaller(
        paths,
        fileSystem,
        workerSource
      )
      const scheduler = new RepoMirrorSchedulerService(
        paths,
        runner,
        stableRunner,
        fileSystem,
        {
          environment,
          platformInfo: { platform: 'linux', uid: 1000 },
          userHome,
        }
      )
      const observation = await scheduler.apply({
        name: 'api',
        schedule: { cron: '5 2 * * 1-5' },
        urls: ['https://example.com/api.git'],
      })
      assert.equal(observation.state, 'ready')
      const { projectionPath } = observation
      assert.ok(projectionPath !== null)
      const timer = await readFile(projectionPath, 'utf-8')
      const service = await readFile(
        projectionPath.replace(/\.timer$/u, '.service'),
        'utf-8'
      )
      assert.match(timer, /OnCalendar=Mon \*-\*-\* 02:05:00/u)
      assert.match(timer, /Persistent=true/u)
      assert.match(service, /ExecStart=/u)
      assert.match(service, /GITS_HOME=/u)
      assert.match(service, /GITS_NATIVE_LOG=.*api\.native\.log/u)
      assert.ok(
        runner.calls.some(
          (call) =>
            call.executable === 'systemctl' && call.args.includes('enable')
        )
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('installs an executable stable runner that delegates without a shell command string', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-stable-runner-test-'))
    try {
      await writeFile(
        resolve(root, 'package.json'),
        JSON.stringify({ type: 'module' })
      )
      const paths = new GitsPathService({
        environment: { GITS_HOME: resolve(root, 'gits-home') },
      })
      const fileSystem = new FileSystemService()
      const nodeDirectory = resolve(root, 'node runtime')
      const nodeExecutable = resolve(nodeDirectory, 'node')
      await mkdir(nodeDirectory)
      await symlink(process.execPath, nodeExecutable)
      const workerSource = resolve(root, 'probe.mjs')
      await fileSystem.writeFileAtomically(
        workerSource,
        `${workerBundleMarker()}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n`
      )
      const installer = new StableRunnerInstaller(
        paths,
        fileSystem,
        workerSource,
        { nodeExecutable }
      )
      const path = await installer.install()
      assert.match(await readFile(path, 'utf-8'), /^#!\/usr\/bin\/env node\n/u)
      await rm(workerSource)
      const result = await executeFile(path, ['one', 'two'], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: installer.invocation('probe').environment.PATH,
        },
      })
      assert.deepEqual(JSON.parse(result.stdout), ['one', 'two'])

      const replacementSource = resolve(root, 'replacement.mjs')
      await fileSystem.writeFileAtomically(
        replacementSource,
        `${workerBundleMarker()}\nprocess.stdout.write('replacement')\n`
      )
      const replacement = new StableRunnerInstaller(
        paths,
        fileSystem,
        replacementSource,
        { nodeExecutable }
      )
      assert.equal(await replacement.refreshIfInstalled(), true)
      const replaced = await executeFile(path, [], { encoding: 'utf-8' })
      assert.equal(replaced.stdout, 'replacement')
      assert.equal((await replacement.inspect()).state, 'ready')
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('caps and rotates native scheduler emergency logs', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-native-log-test-'))
    try {
      const paths = new GitsPathService({
        environment: { GITS_HOME: resolve(root, 'gits-home') },
      })
      const fileSystem = new FileSystemService()
      const workerSource = resolve(root, 'noisy-probe.mjs')
      await fileSystem.writeFileAtomically(
        workerSource,
        `${workerBundleMarker()}\nprocess.stdout.write('discarded')\nprocess.stderr.write(Buffer.alloc(${nativeRepoMirrorLogMaximumBytes + 4096}, 120))\n`
      )
      const installer = new StableRunnerInstaller(
        paths,
        fileSystem,
        workerSource
      )
      const path = await installer.install()
      const nativeLog = resolve(paths.logs, 'api.native.log')

      for (let run = 0; run < nativeRepoMirrorLogMaximumBackups + 2; run += 1) {
        // 每次调用都会轮转上一次输出，因此必须串行执行。
        // eslint-disable-next-line no-await-in-loop
        const result = await executeFile(path, [], {
          encoding: 'utf-8',
          env: { ...process.env, GITS_NATIVE_LOG: nativeLog },
        })
        assert.equal(result.stdout, '')
        assert.equal(result.stderr, '')
      }

      const retainedPaths = Array.from(
        { length: nativeRepoMirrorLogMaximumBackups + 1 },
        (_, index) => (index === 0 ? nativeLog : `${nativeLog}.${index}`)
      )
      const retainedSizes = await Promise.all(
        retainedPaths.map(async (retainedPath) => {
          const metadata = await stat(retainedPath)
          return metadata.size
        })
      )
      assert.deepEqual(
        retainedSizes,
        retainedSizes.map(() => nativeRepoMirrorLogMaximumBytes)
      )
      assert.match(
        await readFile(nativeLog, 'utf-8'),
        /\[gits\] native log output truncated\n$/u
      )
      await assert.rejects(
        stat(`${nativeLog}.${nativeRepoMirrorLogMaximumBackups + 1}`),
        /ENOENT/u
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('forwards termination signals to the scheduled worker', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-runner-signal-test-'))
    try {
      const paths = new GitsPathService({
        environment: { GITS_HOME: resolve(root, 'gits-home') },
      })
      const fileSystem = new FileSystemService()
      const signalPath = resolve(root, 'signal.txt')
      const workerSource = resolve(root, 'signal-probe.mjs')
      await fileSystem.writeFileAtomically(
        workerSource,
        [
          workerBundleMarker(),
          "import { writeFileSync } from 'node:fs'",
          "process.stdout.write('ready\\n')",
          "process.once('SIGTERM', () => {",
          "  writeFileSync(process.env.GITS_SIGNAL_PROBE, 'SIGTERM')",
          '  process.exit(0)',
          '})',
          'setTimeout(() => process.exit(2), 5000)',
          '',
        ].join('\n')
      )
      const installer = new StableRunnerInstaller(
        paths,
        fileSystem,
        workerSource
      )
      const runnerPath = await installer.install()
      const child = spawn(runnerPath, [], {
        env: { ...process.env, GITS_SIGNAL_PROBE: signalPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      await waitForOutput(child.stdout, 'ready')
      child.kill('SIGTERM')
      const [code, signal] = await once(child, 'close')
      assert.equal(code, 0)
      assert.equal(signal, null)
      assert.equal(await readFile(signalPath, 'utf-8'), 'SIGTERM')
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

async function createWorkerSource(root: string): Promise<string> {
  const workerSource = resolve(root, 'repo-mirror-worker.mjs')
  await writeFile(workerSource, `${workerBundleMarker()}\n`, { mode: 0o700 })
  return workerSource
}

function workerBundleMarker(): string {
  return `/* ${gitsManagedArtifactRegistry.schedulerWorker.bundleMarker} */`
}

async function waitForOutput(
  stream: NodeJS.ReadableStream | null,
  expected: string
): Promise<void> {
  assert.notEqual(stream, null)
  await new Promise<void>((resolvePromise, reject) => {
    let output = ''
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${expected}.`)),
      3000
    )
    stream?.on('data', (chunk: Buffer | string) => {
      output += String(chunk)
      if (output.includes(expected)) {
        clearTimeout(timeout)
        resolvePromise()
      }
    })
    stream?.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}
