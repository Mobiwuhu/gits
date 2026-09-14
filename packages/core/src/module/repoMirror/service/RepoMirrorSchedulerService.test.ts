import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, it } from 'node:test'

import { parse } from 'plist'

import type { IProcessService, ProcessResult } from '../../../contract/index'
import { FileSystemService, GitsPathService } from '../../../service/index'
import { RepoMirrorSchedulerService } from './RepoMirrorSchedulerService'
import { compileCalendarEntries } from './portableCron'
import {
  nativeRepoMirrorLogMaximumBackups,
  nativeRepoMirrorLogMaximumBytes,
  StableRunnerInstaller,
} from './StableRunnerInstaller'

const executeFile = promisify(execFile)

class SuccessfulCommandRunner implements IProcessService {
  readonly calls: { readonly args: readonly string[]; readonly executable: string }[] = []

  async run(executable: string, args: readonly string[]): Promise<ProcessResult> {
    this.calls.push({ args, executable })
    return { args, durationMs: 1, exitCode: 0, stderr: '', stdout: '' }
  }
}

describe('native repo mirror scheduler', () => {
  it('preserves cron OR semantics for constrained day-of-month and weekday', () => {
    const entries = compileCalendarEntries('0 1 2 * 3')
    assert.deepEqual(entries, [
      { day: 2, hour: 1, minute: 0 },
      { hour: 1, minute: 0, weekday: 3 },
    ])
  })

  it('rejects cron expressions that would create too many native calendar entries', () => {
    assert.throws(
      () => compileCalendarEntries('0,10,20,30,40,50 0-23 * 1-12 *'),
      /more than 256 native calendar entries/u,
    )
  })

  it('writes and loads a launchd projection through argv-only commands', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-launchd-test-'))
    try {
      const gitsHome = resolve(root, 'gits-home')
      const userHome = resolve(root, 'user-home')
      const paths = new GitsPathService({ environment: { GITS_HOME: gitsHome }, userHome })
      const fileSystem = new FileSystemService()
      const runner = new SuccessfulCommandRunner()
      const stableRunner = new StableRunnerInstaller(paths, fileSystem)
      const scheduler = new RepoMirrorSchedulerService(paths, runner, stableRunner, fileSystem, {
        platformInfo: { platform: 'darwin', uid: 501 },
        userHome,
      })
      const observation = await scheduler.apply({
        name: 'api',
        schedule: { cron: '17 1-23/6 * * *' },
        urls: ['https://example.com/api.git'],
      })
      assert.equal(observation.state, 'ready')
      assert.ok(observation.projectionPath)
      const plist = parse(await readFile(observation.projectionPath, 'utf8')) as Record<
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
        resolve(paths.logs, 'api.native.log'),
      )
      assert.ok(runner.calls.some((call) => call.executable === '/usr/bin/plutil'))
      assert.ok(
        runner.calls.some(
          (call) => call.executable === '/bin/launchctl' && call.args[0] === 'bootstrap',
        ),
      )
      assert.equal(
        (
          await scheduler.inspect({
            name: 'api',
            schedule: { cron: '17 1-23/6 * * *' },
            urls: ['https://example.com/api.git'],
          })
        ).state,
        'ready',
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('writes systemd user service and timer projections', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-systemd-test-'))
    try {
      const gitsHome = resolve(root, 'gits-home')
      const userHome = resolve(root, 'user-home')
      const xdgConfig = resolve(root, 'xdg')
      const environment = { GITS_HOME: gitsHome, XDG_CONFIG_HOME: xdgConfig }
      const paths = new GitsPathService({ environment, userHome })
      const fileSystem = new FileSystemService()
      const runner = new SuccessfulCommandRunner()
      const stableRunner = new StableRunnerInstaller(paths, fileSystem)
      const scheduler = new RepoMirrorSchedulerService(paths, runner, stableRunner, fileSystem, {
        environment,
        platformInfo: { platform: 'linux', uid: 1000 },
        userHome,
      })
      const observation = await scheduler.apply({
        name: 'api',
        schedule: { cron: '5 2 * * 1-5' },
        urls: ['https://example.com/api.git'],
      })
      assert.equal(observation.state, 'ready')
      assert.ok(observation.projectionPath)
      const timer = await readFile(observation.projectionPath, 'utf8')
      const service = await readFile(
        observation.projectionPath.replace(/\.timer$/u, '.service'),
        'utf8',
      )
      assert.match(timer, /OnCalendar=Mon \*-\*-\* 02:05:00/u)
      assert.match(timer, /Persistent=true/u)
      assert.match(service, /ExecStart=/u)
      assert.match(service, /GITS_HOME=/u)
      assert.match(service, /GITS_NATIVE_LOG=.*api\.native\.log/u)
      assert.ok(
        runner.calls.some(
          (call) => call.executable === 'systemctl' && call.args.includes('enable'),
        ),
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('installs an executable stable runner that delegates without a shell command string', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-stable-runner-test-'))
    try {
      const paths = new GitsPathService({
        environment: { GITS_HOME: resolve(root, 'gits-home') },
      })
      const fileSystem = new FileSystemService()
      const cliEntry = resolve(root, 'probe.cjs')
      await fileSystem.writeFileAtomically(
        cliEntry,
        'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n',
      )
      const installer = new StableRunnerInstaller(paths, fileSystem, cliEntry, [])
      const path = await installer.install()
      const result = await executeFile(path, ['one', 'two'], { encoding: 'utf8' })
      assert.deepEqual(JSON.parse(String(result.stdout)), ['one', 'two'])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('caps and rotates native scheduler emergency logs', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-native-log-test-'))
    try {
      const paths = new GitsPathService({
        environment: { GITS_HOME: resolve(root, 'gits-home') },
      })
      const fileSystem = new FileSystemService()
      const cliEntry = resolve(root, 'noisy-probe.cjs')
      await fileSystem.writeFileAtomically(
        cliEntry,
        `process.stdout.write('discarded')\nprocess.stderr.write(Buffer.alloc(${nativeRepoMirrorLogMaximumBytes + 4096}, 120))\n`,
      )
      const installer = new StableRunnerInstaller(paths, fileSystem, cliEntry, [])
      const path = await installer.install()
      const nativeLog = resolve(paths.logs, 'api.native.log')

      for (let run = 0; run < nativeRepoMirrorLogMaximumBackups + 2; run += 1) {
        // Invocations are serial because each one rotates its predecessor's output.
        // eslint-disable-next-line no-await-in-loop
        const result = await executeFile(path, [], {
          encoding: 'utf8',
          env: { ...process.env, GITS_NATIVE_LOG: nativeLog },
        })
        assert.equal(result.stdout, '')
        assert.equal(result.stderr, '')
      }

      const retainedPaths = Array.from(
        { length: nativeRepoMirrorLogMaximumBackups + 1 },
        (_, index) => (index === 0 ? nativeLog : `${nativeLog}.${index}`),
      )
      const retainedSizes = await Promise.all(
        retainedPaths.map(async (retainedPath) => (await stat(retainedPath)).size),
      )
      assert.deepEqual(
        retainedSizes,
        retainedSizes.map(() => nativeRepoMirrorLogMaximumBytes),
      )
      assert.match(await readFile(nativeLog, 'utf8'), /\[gits\] native log output truncated\n$/u)
      await assert.rejects(stat(`${nativeLog}.${nativeRepoMirrorLogMaximumBackups + 1}`), /ENOENT/u)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
