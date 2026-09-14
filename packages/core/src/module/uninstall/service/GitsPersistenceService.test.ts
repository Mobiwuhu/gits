import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, relative, resolve } from 'node:path'
import { describe, it } from 'node:test'

import type { IProcessService, ProcessResult } from '../../../contract/index'
import {
  FileSystemService,
  GitsPathService,
  gitsHomePersistenceRegistry,
} from '../../../service/index'
import { RepoMirrorSchedulerService } from '../../repoMirror/service/RepoMirrorSchedulerService'
import { StableRunnerInstaller } from '../../repoMirror/service/StableRunnerInstaller'
import { GitsPersistenceService } from './GitsPersistenceService'

class SuccessfulCommandRunner implements IProcessService {
  readonly calls: { readonly args: readonly string[]; readonly executable: string }[] = []

  async run(executable: string, args: readonly string[]): Promise<ProcessResult> {
    this.calls.push({ args, executable })
    return { args, durationMs: 1, exitCode: 0, stderr: '', stdout: '' }
  }
}

describe('gits persistence registry and uninstall cleanup', () => {
  it('derives every GITS_HOME path and directory from the central registry', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-persistence-registry-test-'))
    try {
      const home = resolve(root, 'gits-home')
      const paths = new GitsPathService({ environment: { GITS_HOME: home } })
      assert.deepEqual(
        Object.keys(paths).toSorted(),
        ['home', ...Object.keys(gitsHomePersistenceRegistry)].toSorted(),
      )
      for (const [key, entry] of Object.entries(gitsHomePersistenceRegistry)) {
        const path = paths[key as keyof typeof gitsHomePersistenceRegistry]
        assert.equal(relative(home, path), entry.relativePath)
      }

      await paths.ensureLayout()
      await Promise.all(
        Object.entries(gitsHomePersistenceRegistry)
          .filter(([, entry]) => entry.kind === 'directory')
          .map(([key]) => access(paths[key as keyof typeof gitsHomePersistenceRegistry])),
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('removes owned LaunchAgents and the data root but preserves unrelated files', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-persistence-launchd-test-'))
    try {
      const userHome = resolve(root, 'user-home')
      const gitsHome = resolve(root, 'gits-home')
      const paths = new GitsPathService({ environment: { GITS_HOME: gitsHome }, userHome })
      const runner = new SuccessfulCommandRunner()
      const fileSystem = new FileSystemService()
      const stableRunner = new StableRunnerInstaller(paths, fileSystem)
      const scheduler = new RepoMirrorSchedulerService(paths, runner, stableRunner, fileSystem, {
        platformInfo: { platform: 'darwin', uid: 501 },
        userHome,
      })
      const observation = await scheduler.apply({
        name: 'api',
        schedule: { cron: '5 2 * * *' },
        urls: ['https://example.com/api.git'],
      })
      assert.equal(observation.state, 'ready')
      assert.ok(observation.projectionPath)
      const unrelated = resolve(
        userHome,
        'Library/LaunchAgents/io.gits.repo-mirror.unrelated.plist',
      )
      await writeFile(unrelated, '<plist><dict></dict></plist>')
      await writeFile(resolve(gitsHome, 'future-cache'), 'registered by a future feature\n')

      const persistence = new GitsPersistenceService(paths, runner, {
        environment: { XDG_CONFIG_HOME: 'relative-but-irrelevant-on-macos' },
        platform: 'darwin',
        uid: 501,
        userHome,
      })
      const inventory = await persistence.inspect()
      assert.ok(inventory.some((target) => target.path === observation.projectionPath))
      assert.ok(inventory.some((target) => target.kind === 'unregistered'))
      assert.ok(!inventory.some((target) => target.path === unrelated))

      const purged = await persistence.purge()
      assert.ok(purged.removedPaths.includes(gitsHome))
      await assert.rejects(() => access(gitsHome))
      await assert.rejects(() => access(observation.projectionPath!))
      assert.match(await readFile(unrelated, 'utf8'), /<plist>/u)
      assert.ok(
        runner.calls.some(
          (call) => call.executable === '/bin/launchctl' && call.args[0] === 'bootout',
        ),
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('refuses to recursively remove the user home even when configured as GITS_HOME', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-persistence-safety-test-'))
    try {
      const userHome = resolve(root, 'user-home')
      const paths = new GitsPathService({ environment: { GITS_HOME: userHome }, userHome })
      await paths.ensureLayout()
      await writeFile(resolve(userHome, 'keep-me'), 'user data\n')

      const persistence = new GitsPersistenceService(paths, new SuccessfulCommandRunner(), {
        platform: 'darwin',
        userHome,
      })
      await assert.rejects(() => persistence.purge(), {
        code: 'uninstall-safety',
      })
      assert.equal(await readFile(resolve(userHome, 'keep-me'), 'utf8'), 'user data\n')
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('removes owned systemd user units and reloads the user manager', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-persistence-systemd-test-'))
    try {
      const userHome = resolve(root, 'user-home')
      const gitsHome = resolve(root, 'gits-home')
      const xdgConfig = resolve(root, 'xdg')
      const environment = { GITS_HOME: gitsHome, XDG_CONFIG_HOME: xdgConfig }
      const paths = new GitsPathService({ environment, userHome })
      const runner = new SuccessfulCommandRunner()
      const fileSystem = new FileSystemService()
      const stableRunner = new StableRunnerInstaller(paths, fileSystem)
      const scheduler = new RepoMirrorSchedulerService(paths, runner, stableRunner, fileSystem, {
        environment,
        platformInfo: { platform: 'linux', uid: 1000 },
        userHome,
      })
      const observation = await scheduler.apply({
        name: 'api',
        schedule: { cron: '5 2 * * *' },
        urls: ['https://example.com/api.git'],
      })
      assert.equal(observation.state, 'ready')
      assert.ok(observation.projectionPath)
      const enablementDirectory = resolve(xdgConfig, 'systemd/user/timers.target.wants')
      const enablement = resolve(enablementDirectory, basename(observation.projectionPath))
      await mkdir(enablementDirectory, { recursive: true })
      await symlink(`../${basename(observation.projectionPath)}`, enablement)

      const persistence = new GitsPersistenceService(paths, runner, {
        environment,
        platform: 'linux',
        uid: 1000,
        userHome,
      })
      const inventory = await persistence.inspect()
      const units = inventory.filter((target) => target.id.startsWith('systemd'))
      assert.equal(units.length, 3)
      assert.ok(units.some((unit) => unit.path === enablement))

      await persistence.purge()
      await assert.rejects(() => access(gitsHome))
      await Promise.all(units.map((unit) => assert.rejects(() => access(unit.path))))
      assert.ok(
        runner.calls.some(
          (call) => call.executable === 'systemctl' && call.args.includes('disable'),
        ),
      )
      assert.ok(
        runner.calls.some(
          (call) => call.executable === 'systemctl' && call.args.includes('daemon-reload'),
        ),
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
