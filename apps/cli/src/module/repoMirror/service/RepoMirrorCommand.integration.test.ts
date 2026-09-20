import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const executeFile = promisify(execFile)
const repositoryRoot = resolve(
  dirname(new URL(import.meta.url).pathname),
  '../../../../../..'
)
const cliEntry = resolve(repositoryRoot, 'apps/cli/src/index.ts')
const schedulerWorkerBundleMarker = 'gits-repo-mirror-worker-bundle:v1'
const schedulerWorkerFileName = 'gits-repo-mirror-worker.mjs'
const stableSchedulerRunnerFileName = 'gits-repo-mirror-runner.cjs'

interface CommandResponse {
  readonly code: number
  readonly stderr: string
  readonly stdout: string
}

interface CommandFailure extends Error {
  readonly code?: number
  readonly stderr?: string | Buffer
  readonly stdout?: string | Buffer
}

interface MirrorOutput {
  readonly command: string
  readonly mirrors: readonly {
    readonly action: string
    readonly dependents: readonly string[]
    readonly error: { readonly code: string; readonly message: string } | null
    readonly forced?: boolean
    readonly name: string
    readonly nextFetchAt: string | null
    readonly path: string
    readonly repositoryState: string
    readonly schedule: { readonly cron: string } | null
    readonly scheduleState: string
    readonly urls: readonly string[]
  }[]
  readonly ok: boolean
}

interface InstallOutput {
  readonly ok: boolean
  readonly repos: readonly {
    readonly mirror?: {
      readonly dissociated: boolean
      readonly name: string
      readonly path: string
    }
    readonly result: string
  }[]
}

interface UninstallOutput {
  readonly command: 'uninstall'
  readonly dryRun: boolean
  readonly mirrors: readonly {
    readonly dependents: readonly string[]
    readonly name: string
    readonly path: string
  }[]
  readonly ok: boolean
  readonly removedMirrors: readonly string[]
  readonly removedPaths: readonly string[]
  readonly targets: readonly {
    readonly exists: boolean
    readonly id: string
    readonly kind: string
    readonly path: string
  }[]
  readonly warnings: readonly string[]
}

void describe('gits repo-mirrors', () => {
  void it('creates, lists, fetches, updates, and resolves a mirror path', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-mirror-crud-test-'))
    const gitsHome = resolve(root, 'gits-home')
    try {
      const remote = await createRemote(root)
      const remoteUrl = pathToFileURL(remote).href
      const added = await gits(
        [
          'repo-mirrors',
          'add',
          remoteUrl,
          '--alias',
          remote,
          '--name',
          'api',
          '--schedule',
          'off',
          '--yes',
          '--json',
        ],
        gitsHome
      )
      assert.equal(added.code, 0, added.stderr)
      const created = parseMirrors(added)
      assert.equal(created.mirrors[0]?.action, 'created')
      assert.deepEqual(created.mirrors[0]?.urls, [remoteUrl, remote])
      assert.equal(created.mirrors[0]?.schedule, null)
      const localMirrorPath = created.mirrors[0]?.path
      assert.ok(localMirrorPath)

      const task = resolve(root, 'task')
      await mkdir(task)
      await writeTaskConfiguration(task, remote, false)
      const fromTask = await gits(
        [
          '-C',
          task,
          'repo-mirrors',
          'add',
          'api',
          '--from-task',
          '--schedule',
          'off',
          '--yes',
          '--json',
        ],
        gitsHome
      )
      assert.equal(fromTask.code, 0, fromTask.stderr)
      assert.equal(parseMirrors(fromTask).mirrors[0]?.action, 'unchanged')

      const repeated = await gits(
        [
          'repo-mirrors',
          'add',
          remoteUrl,
          '--schedule',
          'off',
          '--yes',
          '--json',
        ],
        gitsHome
      )
      assert.equal(repeated.code, 0, repeated.stderr)
      assert.equal(parseMirrors(repeated).mirrors[0]?.action, 'unchanged')

      const updated = await gits(
        ['repo-mirrors', 'set', 'api', '--url', remote, '--json'],
        gitsHome
      )
      assert.equal(updated.code, 0, updated.stderr)
      assert.equal(parseMirrors(updated).mirrors[0]?.action, 'updated')
      assert.deepEqual(parseMirrors(updated).mirrors[0]?.urls, [
        remote,
        remoteUrl,
      ])

      const listed = await gits(
        ['repo-mirrors', 'list', '--wide', '--json'],
        gitsHome
      )
      assert.equal(listed.code, 0, listed.stderr)
      assert.equal(parseMirrors(listed).mirrors[0]?.repositoryState, 'ready')

      const path = await gits(['repo-mirrors', 'path', 'api'], gitsHome)
      assert.equal(path.code, 0, path.stderr)
      assert.equal(path.stdout.trim(), created.mirrors[0]?.path)

      const unknownPath = await gits(
        ['repo-mirrors', 'path', 'missing'],
        gitsHome
      )
      assert.equal(unknownPath.code, 2)
      assert.equal(unknownPath.stdout, '')

      const invalidRemoval = await gits(
        [
          'repo-mirrors',
          'remove',
          'api',
          '--detach-dependents',
          '--force',
          '--yes',
          '--json',
        ],
        gitsHome
      )
      assert.notEqual(invalidRemoval.code, 0)
      assert.match(
        `${invalidRemoval.stdout}\n${invalidRemoval.stderr}`,
        /--force and --detach-dependents cannot be combined/u
      )

      const fetched = await gits(
        ['repo-mirrors', 'fetch', 'api', '--json'],
        gitsHome
      )
      assert.equal(fetched.code, 0, fetched.stderr)
      assert.equal(parseMirrors(fetched).mirrors[0]?.action, 'fetched')
      const logs = await gits(
        ['repo-mirrors', 'logs', 'api', '--json'],
        gitsHome
      )
      assert.equal(logs.code, 0, logs.stderr)
      assert.match(logs.stdout, /git-command/u)

      const unsetManagedMarker = await git(
        ['config', '--unset', 'gits.repoMirror.managed'],
        localMirrorPath
      )
      assert.equal(unsetManagedMarker.code, 0)
      const unmanagedRemoval = await gits(
        [
          'repo-mirrors',
          'remove',
          'api',
          '--force',
          '--purge',
          '--yes',
          '--json',
        ],
        gitsHome
      )
      assert.equal(unmanagedRemoval.code, 1)
      assert.equal(
        parseMirrors(unmanagedRemoval).mirrors[0]?.error?.code,
        'mirror-unmanaged-path'
      )
      await access(localMirrorPath)

      const forcedUninstall = await gits(
        ['uninstall', '--force', '--yes', '--json'],
        gitsHome
      )
      assert.equal(forcedUninstall.code, 0, forcedUninstall.stderr)
      const forcedUninstallOutput = JSON.parse(
        forcedUninstall.stdout
      ) as UninstallOutput
      assert.deepEqual(forcedUninstallOutput.removedMirrors, ['api'])
      await assert.rejects(async () => access(gitsHome))
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('reports an unhealthy scheduler when doctor runs without --fix', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-doctor-schedule-test-'))
    const gitsHome = resolve(root, 'gits-home')
    try {
      const remote = await createRemote(root)
      const remoteUrl = pathToFileURL(remote).href
      const added = await gits(
        [
          'repo-mirrors',
          'add',
          remoteUrl,
          '--name',
          'api',
          '--schedule',
          'off',
          '--yes',
          '--json',
        ],
        gitsHome
      )
      assert.equal(added.code, 0, added.stderr)
      await writeFile(
        resolve(gitsHome, 'config.jsonc'),
        `${JSON.stringify(
          {
            repoMirrors: [
              {
                name: 'api',
                schedule: { cron: '17 1-23/6 * * *' },
                urls: [remoteUrl],
              },
            ],
            repoMirrorsSettings: { maxConcurrentFetches: 4 },
            version: 1,
          },
          null,
          2
        )}\n`
      )

      const checked = await gits(
        ['repo-mirrors', 'doctor', 'api', '--json'],
        gitsHome
      )
      assert.notEqual(checked.code, 0)
      const output = parseMirrors(checked)
      assert.equal(output.ok, false)
      assert.equal(output.mirrors[0]?.error?.code, 'scheduler-invalid')
      assert.ok(
        ['drifted', 'unavailable'].includes(
          output.mirrors[0]?.scheduleState ?? ''
        )
      )
      assert.equal(output.mirrors[0]?.nextFetchAt, null)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('uses alternates by default and protects, maintains, then safely detaches dependents', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-mirror-install-test-'))
    const gitsHome = resolve(root, 'gits-home')
    const task = resolve(root, 'task')
    try {
      const remote = await createRemote(root)
      await mkdir(task)
      await gits(['-C', task, 'init', '--json'], gitsHome)
      await writeTaskConfiguration(task, remote, false, ['knowledge'])
      const added = await gits(
        [
          'repo-mirrors',
          'add',
          pathToFileURL(remote).href,
          '--name',
          'api',
          '--schedule',
          'off',
          '--yes',
          '--json',
        ],
        gitsHome
      )
      assert.equal(added.code, 0, added.stderr)
      const mirrorPath = parseMirrors(added).mirrors[0]?.path
      assert.ok(mirrorPath !== undefined)

      const installed = await gits(['-C', task, 'install', '--json'], gitsHome)
      assert.equal(installed.code, 0, installed.stderr)
      const installOutput = JSON.parse(installed.stdout) as InstallOutput
      assert.deepEqual(installOutput.repos[0]?.mirror, {
        dissociated: false,
        name: 'api',
        path: mirrorPath,
      })
      const repository = resolve(task, 'repos/api')
      const alternates = await readFile(
        resolve(repository, '.git/objects/info/alternates'),
        'utf-8'
      )
      assert.match(alternates, /repo-mirrors\/api\.git\/objects/u)
      await access(resolve(repository, 'knowledge/guide.md'))
      await assert.rejects(async () =>
        access(resolve(repository, 'other/application.txt'))
      )

      const blocked = await gits(
        ['repo-mirrors', 'remove', 'api', '--yes', '--json'],
        gitsHome
      )
      assert.equal(blocked.code, 1)
      assert.equal(
        parseMirrors(blocked).mirrors[0]?.error?.code,
        'mirror-has-dependents'
      )

      const maintenance = await gits(
        ['repo-mirrors', 'fetch', 'api', '--maintenance', '--json'],
        gitsHome
      )
      assert.equal(maintenance.code, 1)
      assert.equal(
        parseMirrors(maintenance).mirrors[0]?.error?.code,
        'mirror-has-dependents'
      )

      const removed = await gits(
        [
          'repo-mirrors',
          'remove',
          'api',
          '--detach-dependents',
          '--yes',
          '--json',
        ],
        gitsHome
      )
      assert.equal(removed.code, 0, removed.stderr)
      assert.equal(parseMirrors(removed).mirrors[0]?.action, 'removed')
      await assert.rejects(async () =>
        access(resolve(repository, '.git/objects/info/alternates'))
      )
      const fsck = await git(['fsck', '--full', '--no-dangling'], repository)
      const log = await git(['log', '-1', '--format=%s'], repository)
      const trashEntries = await readdir(resolve(gitsHome, 'trash'))
      assert.equal(fsck.code, 0)
      assert.equal(log.stdout.trim(), 'initial')
      assert.ok(trashEntries.some((entry) => entry.endsWith('-api.git')))
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('dissociates only when task.config.jsonc explicitly requests it', async () => {
    const root = await mkdtemp(
      resolve(tmpdir(), 'gits-mirror-dissociate-test-')
    )
    const gitsHome = resolve(root, 'gits-home')
    const task = resolve(root, 'task')
    try {
      const remote = await createRemote(root)
      await mkdir(task)
      await gits(['-C', task, 'init', '--json'], gitsHome)
      await writeTaskConfiguration(task, remote, true)
      await gits(
        [
          'repo-mirrors',
          'add',
          pathToFileURL(remote).href,
          '--name',
          'api',
          '--schedule',
          'off',
          '--yes',
          '--json',
        ],
        gitsHome
      )

      const installed = await gits(['-C', task, 'install', '--json'], gitsHome)
      assert.equal(installed.code, 0, installed.stderr)
      const output = JSON.parse(installed.stdout) as InstallOutput
      assert.equal(output.repos[0]?.mirror?.dissociated, true)
      await assert.rejects(async () =>
        access(resolve(task, 'repos/api/.git/objects/info/alternates'))
      )

      const removed = await gits(
        ['repo-mirrors', 'remove', 'api', '--yes', '--json'],
        gitsHome
      )
      assert.equal(removed.code, 0, removed.stderr)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('supports an explicit forced removal while reporting impacted repositories', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-mirror-force-test-'))
    const gitsHome = resolve(root, 'gits-home')
    const task = resolve(root, 'task')
    try {
      const remote = await createRemote(root)
      await mkdir(task)
      await gits(['-C', task, 'init', '--json'], gitsHome)
      await writeTaskConfiguration(task, remote, false)
      await gits(
        [
          'repo-mirrors',
          'add',
          pathToFileURL(remote).href,
          '--name',
          'api',
          '--schedule',
          'off',
          '--yes',
          '--json',
        ],
        gitsHome
      )
      await gits(['-C', task, 'install', '--json'], gitsHome)

      const removed = await gits(
        ['repo-mirrors', 'remove', 'api', '--force', '--yes', '--json'],
        gitsHome
      )
      assert.equal(removed.code, 0, removed.stderr)
      const [result] = parseMirrors(removed).mirrors
      assert.equal(result?.forced, true)
      assert.deepEqual(result?.dependents, [resolve(task, 'repos/api')])
      await access(resolve(task, 'repos/api/.git/objects/info/alternates'))
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('previews and safely uninstalls all registered machine data', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-uninstall-test-'))
    const gitsHome = resolve(root, 'gits-home')
    const task = resolve(root, 'task')
    try {
      const remote = await createRemote(root)
      await mkdir(task)
      await gits(['-C', task, 'init', '--json'], gitsHome)
      await writeTaskConfiguration(task, remote, false)
      await gits(
        [
          'repo-mirrors',
          'add',
          pathToFileURL(remote).href,
          '--name',
          'api',
          '--schedule',
          'off',
          '--yes',
          '--json',
        ],
        gitsHome
      )
      await gits(['-C', task, 'install', '--json'], gitsHome)

      const preview = await gits(['uninstall', '--dry-run', '--json'], gitsHome)
      assert.equal(preview.code, 0, preview.stderr)
      const previewOutput = JSON.parse(preview.stdout) as UninstallOutput
      assert.equal(previewOutput.dryRun, true)
      assert.equal(previewOutput.mirrors[0]?.name, 'api')
      assert.deepEqual(previewOutput.mirrors[0]?.dependents, [
        resolve(task, 'repos/api'),
      ])
      assert.ok(
        previewOutput.targets.some((target) => target.id === 'gits-home')
      )
      await access(gitsHome)

      const blocked = await gits(['uninstall', '--yes', '--json'], gitsHome)
      assert.equal(blocked.code, 1)
      assert.match(blocked.stdout, /--detach-dependents/u)
      await access(gitsHome)

      const uninstalled = await gits(
        ['uninstall', '--detach-dependents', '--yes', '--json'],
        gitsHome
      )
      assert.equal(uninstalled.code, 0, uninstalled.stderr)
      const uninstallOutput = JSON.parse(uninstalled.stdout) as UninstallOutput
      assert.equal(uninstallOutput.ok, true)
      assert.deepEqual(uninstallOutput.removedMirrors, ['api'])
      assert.ok(uninstallOutput.removedPaths.includes(gitsHome))
      await assert.rejects(async () => access(gitsHome))

      const repository = resolve(task, 'repos/api')
      await assert.rejects(async () =>
        access(resolve(repository, '.git/objects/info/alternates'))
      )
      const fsck = await git(['fsck', '--full', '--no-dangling'], repository)
      assert.equal(fsck.code, 0)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('requires force before uninstalling an owned data root with invalid configuration', async () => {
    const root = await mkdtemp(
      resolve(tmpdir(), 'gits-uninstall-invalid-config-test-')
    )
    const gitsHome = resolve(root, 'gits-home')
    try {
      await mkdir(resolve(gitsHome, 'logs'), { recursive: true })
      await writeFile(
        resolve(gitsHome, 'installation-id'),
        '00000000-0000-4000-8000-000000000001\n'
      )
      await writeFile(
        resolve(gitsHome, 'config.jsonc'),
        '{ this is not valid JSONC'
      )

      const refused = await gits(['uninstall', '--yes', '--json'], gitsHome)
      assert.equal(refused.code, 2)
      await access(gitsHome)

      const forced = await gits(
        ['uninstall', '--force', '--yes', '--json'],
        gitsHome
      )
      assert.equal(forced.code, 0, forced.stderr)
      const output = JSON.parse(forced.stdout) as UninstallOutput
      assert.ok(
        output.warnings.some((warning) => warning.includes('could not be read'))
      )
      await assert.rejects(async () => access(gitsHome))
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('repairs the scheduler runner before an invalid config blocks doctor', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-doctor-runner-test-'))
    const gitsHome = resolve(root, 'gits-home')
    const cliWrapper = resolve(root, 'cli-wrapper.mjs')
    const workerSource = resolve(root, 'repo-mirror-worker.mjs')
    try {
      await mkdir(gitsHome, { recursive: true })
      await writeFile(
        resolve(gitsHome, 'config.jsonc'),
        '{ this is not valid JSONC'
      )
      const workerContent = `/* ${schedulerWorkerBundleMarker} */\nprocess.stdout.write('worker-ready')\n`
      await writeFile(workerSource, workerContent)
      const bootstrapEntry = pathToFileURL(
        resolve(repositoryRoot, 'apps/cli/src/bootstrap/index.ts')
      ).href
      const contractEntry = pathToFileURL(
        resolve(repositoryRoot, 'apps/cli/src/contract/index.ts')
      ).href
      await writeFile(
        cliWrapper,
        [
          `import { createContainer } from ${JSON.stringify(bootstrapEntry)}`,
          `import { ICliApplication } from ${JSON.stringify(contractEntry)}`,
          `const container = createContainer(${JSON.stringify(workerSource)})`,
          'try {',
          '  await container.get(ICliApplication).run(process.argv.slice(2))',
          '} finally {',
          '  container.dispose()',
          '}',
          '',
        ].join('\n')
      )

      const repaired = await run(
        process.execPath,
        [
          '--import=tsx',
          '--conditions=@usegit/source',
          cliWrapper,
          'repo-mirrors',
          'doctor',
          '--fix',
          '--yes',
          '--json',
        ],
        repositoryRoot,
        { GITS_HOME: gitsHome }
      )
      assert.notEqual(repaired.code, 0)
      assert.match(`${repaired.stdout}\n${repaired.stderr}`, /Cannot parse/u)

      const installedWorker = resolve(gitsHome, 'bin', schedulerWorkerFileName)
      const installedRunner = resolve(
        gitsHome,
        'bin',
        stableSchedulerRunnerFileName
      )
      assert.equal(await readFile(installedWorker, 'utf-8'), workerContent)
      const runnerContent = await readFile(installedRunner, 'utf-8')
      assert.match(
        runnerContent,
        new RegExp(escapeRegExp(installedWorker), 'u')
      )
      assert.doesNotMatch(
        runnerContent,
        new RegExp(escapeRegExp(workerSource), 'u')
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

async function gits(
  args: readonly string[],
  gitsHome: string
): Promise<CommandResponse> {
  return run(
    process.execPath,
    ['--import=tsx', '--conditions=@usegit/source', cliEntry, ...args],
    repositoryRoot,
    {
      GITS_HOME: gitsHome,
    }
  )
}

async function git(
  args: readonly string[],
  cwd: string
): Promise<CommandResponse> {
  return run('git', args, cwd)
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = {}
): Promise<CommandResponse> {
  try {
    const response = await executeFile(command, args, {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, ...environment },
    })
    return {
      code: 0,
      stderr: response.stderr,
      stdout: response.stdout,
    }
  } catch (error) {
    const failure = error as CommandFailure
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stderr: String(failure.stderr ?? ''),
      stdout: String(failure.stdout ?? ''),
    }
  }
}

async function createRemote(root: string): Promise<string> {
  const remote = resolve(root, 'origin.git')
  const seed = resolve(root, 'seed')
  await git(['init', '--bare', remote], root)
  await git(['init', '-b', 'main', seed], root)
  await git(['config', 'user.email', 'gits@test.invalid'], seed)
  await git(['config', 'user.name', 'gits-test'], seed)
  await mkdir(resolve(seed, 'knowledge'), { recursive: true })
  await mkdir(resolve(seed, 'other'), { recursive: true })
  await writeFile(resolve(seed, 'README.md'), 'initial\n')
  await writeFile(resolve(seed, 'knowledge/guide.md'), 'knowledge\n')
  await writeFile(resolve(seed, 'other/application.txt'), 'other\n')
  await git(['add', '.'], seed)
  await git(['commit', '-m', 'initial'], seed)
  await git(['remote', 'add', 'origin', pathToFileURL(remote).href], seed)
  await git(['push', '-u', 'origin', 'main'], seed)
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote)
  return remote
}

async function writeTaskConfiguration(
  task: string,
  remote: string,
  dissociate: boolean,
  checkout?: readonly string[]
): Promise<void> {
  const config = {
    repos: {
      api: {
        branch: 'feat/task-1',
        ...(checkout === undefined ? {} : { checkout }),
        ...(dissociate ? { dissociate: true } : {}),
        from: 'origin/main',
        url: pathToFileURL(remote).href,
      },
    },
  }
  await writeFile(
    resolve(task, 'task.config.jsonc'),
    `${JSON.stringify(config, null, 2)}\n`
  )
}

function parseMirrors(response: CommandResponse): MirrorOutput {
  return JSON.parse(response.stdout) as MirrorOutput
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
