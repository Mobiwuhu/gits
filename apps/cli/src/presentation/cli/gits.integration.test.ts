import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, it } from 'node:test'

const executeFile = promisify(execFile)
const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), '../../../../..')
const cliEntry = resolve(repositoryRoot, 'apps/cli/src/index.ts')

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

interface JsonCommandOutput {
  readonly command: string
  readonly ok: boolean
  readonly repos: readonly {
    readonly actual: {
      readonly ahead: number | null
      readonly behind: number | null
      readonly branch: string | null
      readonly checkout: readonly string[] | null
      readonly upstream: string | null
    }
    readonly error: { readonly code: string; readonly message: string } | null
    readonly expected: {
      readonly checkout: readonly string[] | null
    }
    readonly flags: readonly string[]
    readonly name: string
    readonly result: string
    readonly state: string | null
  }[]
}

describe('gits CLI', () => {
  it('creates an idempotent scaffold and reports incomplete configuration before Git work', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-init-test-'))
    const task = resolve(root, 'task')
    await mkdir(task)

    try {
      const initialized = await gits(['-C', task, 'init', '--json'])
      assert.equal(initialized.code, 0)
      assert.deepEqual(parseOutput(initialized).repos, [])

      await writeFile(resolve(task, 'AGENTS.md'), 'preserve this content\n')
      const repeated = await gits(['-C', task, 'init', '--json'])
      assert.equal(repeated.code, 0)
      assert.equal(await readFile(resolve(task, 'AGENTS.md'), 'utf8'), 'preserve this content\n')

      const incomplete = await gits(['-C', task, 'status', '--json'])
      assert.equal(incomplete.code, 2)
      const output = parseOutput(incomplete)
      assert.equal(output.ok, false)
      assert.equal(output.repos[0]?.state, null)
      assert.equal(output.repos[0]?.error?.code, 'config-incomplete')

      const invalidJobs = await gits(['-C', task, 'fetch', '--jobs', 'not-a-number', '--json'])
      assert.equal(invalidJobs.code, 2)
      assert.equal(parseOutput(invalidJobs).command, 'fetch')

      const implicitPush = await gits(['-C', task, 'push', '--json'])
      assert.equal(implicitPush.code, 2)
      assert.equal(parseOutput(implicitPush).command, 'push')
      await Promise.all([
        access(resolve(task, 'docs')),
        access(resolve(task, 'scripts')),
        access(resolve(task, 'repos')),
      ])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('installs, switches, and pushes a task branch through -C', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-workflow-test-'))

    try {
      const remote = await createRemote(root)
      const task = resolve(root, 'task')
      await mkdir(task)
      await gits(['-C', task, 'init', '--json'])
      await writeTaskConfiguration(task, remote)

      const installed = await gits(['-C', task, 'install', '--json'])
      assert.equal(installed.code, 0)
      assert.equal(parseOutput(installed).repos[0]?.state, 'local-only')
      assert.notEqual(
        (await git(['rev-parse', '--abbrev-ref', '@{upstream}'], resolve(task, 'repos/api'))).code,
        0,
      )

      const nestedDirectory = resolve(task, 'docs/nested')
      await mkdir(nestedDirectory, { recursive: true })
      const localOnly = await gits(['-C', nestedDirectory, 'status', '--json'])
      assert.equal(localOnly.code, 0)
      assert.equal(parseOutput(localOnly).repos[0]?.state, 'local-only')

      const pushed = await gits(['-C', task, 'push', 'api', '--json'])
      assert.equal(pushed.code, 0)
      assert.equal(parseOutput(pushed).repos[0]?.state, 'synced-local')
      assert.equal(
        (
          await git(
            ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
            resolve(task, 'repos/api'),
          )
        ).stdout.trim(),
        'origin/feat/task-1',
      )

      await git(['config', 'user.email', 'gits@test.invalid'], resolve(task, 'repos/api'))
      await git(['config', 'user.name', 'gits-test'], resolve(task, 'repos/api'))
      await git(['commit', '--allow-empty', '-m', 'follow-up'], resolve(task, 'repos/api'))
      const ahead = await gits(['-C', task, 'status', '--json'])
      assert.equal(ahead.code, 0)
      assert.equal(parseOutput(ahead).repos[0]?.state, 'ahead')
      assert.equal(parseOutput(ahead).repos[0]?.actual.ahead, 1)

      const pushedAhead = await gits(['-C', task, 'push', 'api', '--json'])
      assert.equal(pushedAhead.code, 0)
      assert.equal(parseOutput(pushedAhead).repos[0]?.state, 'synced-local')

      await git(['switch', '-c', 'experiment'], resolve(task, 'repos/api'))
      await writeFile(resolve(task, 'repos/api/scratch.txt'), 'dirty\n')
      const refusedSwitch = await gits(['-C', task, 'switch', '--json'])
      assert.equal(refusedSwitch.code, 1)
      assert.equal(parseOutput(refusedSwitch).repos[0]?.error?.code, 'dirty-worktree')

      const stashedSwitch = await gits(['-C', task, 'switch', '--stash', '--json'])
      assert.equal(stashedSwitch.code, 0)
      assert.equal(parseOutput(stashedSwitch).repos[0]?.state, 'synced-local')
      await git(['rev-parse', '--verify', 'refs/stash'], resolve(task, 'repos/api'))
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('installs, reports, switches, and safely reconciles checkout directories', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-sparse-checkout-test-'))

    try {
      const remote = await createRemote(root)
      const task = resolve(root, 'task')
      const repository = resolve(task, 'repos/api')
      await mkdir(task)
      await gits(['-C', task, 'init', '--json'])
      await writeTaskConfiguration(task, remote, ['knowledge'])

      const installed = await gits(['-C', task, 'install', '--json'])
      assert.equal(installed.code, 0, installed.stderr)
      const installedRepository = parseOutput(installed).repos[0]
      assert.deepEqual(installedRepository?.expected.checkout, ['knowledge'])
      assert.deepEqual(installedRepository?.actual.checkout, ['knowledge'])
      await access(resolve(repository, 'knowledge/guide.md'))
      await assert.rejects(() => access(resolve(repository, 'other/application.txt')))
      assert.equal((await git(['sparse-checkout', 'list'], repository)).stdout.trim(), 'knowledge')

      await git(['sparse-checkout', 'set', '--cone', '--no-sparse-index', 'other'], repository)
      const drifted = await gits(['-C', task, 'status', '--json'])
      assert.equal(drifted.code, 1)
      assert.ok(parseOutput(drifted).repos[0]?.flags.includes('checkout-different'))

      const reconciled = await gits(['-C', task, 'install', '--json'])
      assert.equal(reconciled.code, 0, reconciled.stderr)
      assert.equal(parseOutput(reconciled).repos[0]?.result, 'success')
      await access(resolve(repository, 'knowledge/guide.md'))
      await assert.rejects(() => access(resolve(repository, 'other/application.txt')))

      await git(['sparse-checkout', 'set', '--cone', '--no-sparse-index', 'other'], repository)
      const switched = await gits(['-C', task, 'switch', '--json'])
      assert.equal(switched.code, 0, switched.stderr)
      assert.deepEqual(parseOutput(switched).repos[0]?.actual.checkout, ['knowledge'])
      await access(resolve(repository, 'knowledge/guide.md'))

      await writeFile(resolve(repository, 'knowledge/guide.md'), 'locally modified\n')
      await writeTaskConfiguration(task, remote, ['other'])
      const dirty = await gits(['-C', task, 'install', '--json'])
      assert.equal(dirty.code, 1)
      assert.equal(parseOutput(dirty).repos[0]?.error?.code, 'dirty-worktree')
      assert.equal(
        await readFile(resolve(repository, 'knowledge/guide.md'), 'utf8'),
        'locally modified\n',
      )
      assert.equal((await git(['sparse-checkout', 'list'], repository)).stdout.trim(), 'knowledge')

      await git(['reset', '--hard', 'HEAD'], repository)
      await writeTaskConfiguration(task, remote, ['missing-directory'])
      const missing = await gits(['-C', task, 'install', '--json'])
      assert.equal(missing.code, 1)
      assert.equal(parseOutput(missing).repos[0]?.error?.code, 'checkout-path-missing')
      assert.equal((await git(['sparse-checkout', 'list'], repository)).stdout.trim(), 'knowledge')

      await writeTaskConfiguration(task, remote)
      const expanded = await gits(['-C', task, 'install', '--json'])
      assert.equal(expanded.code, 0, expanded.stderr)
      assert.equal(parseOutput(expanded).repos[0]?.actual.checkout, null)
      await access(resolve(repository, 'other/application.txt'))
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('leaves no repository behind when a configured checkout directory is missing', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-sparse-missing-test-'))

    try {
      const remote = await createRemote(root)
      const task = resolve(root, 'task')
      await mkdir(task)
      await gits(['-C', task, 'init', '--json'])
      await writeTaskConfiguration(task, remote, ['missing-directory'])

      const installed = await gits(['-C', task, 'install', '--json'])
      assert.equal(installed.code, 1)
      assert.equal(parseOutput(installed).repos[0]?.error?.code, 'checkout-path-missing')
      await assert.rejects(() => access(resolve(task, 'repos/api')))
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('imports a source task configuration and scripts without modifying the source task', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-scan-test-'))
    const source = resolve(root, 'source-task')
    const target = resolve(root, 'target-task')
    const sourceConfig = [
      '{',
      '  // Imported verbatim from the source task.',
      '  "metadata": { "owner": "platform" },',
      '  "repos": {',
      '    "project-manager": {',
      '      "url": "git@code.byted.org:ad/project_manager_fe.git",',
      '      "branch": "fix/save-btn-state",',
      '      "from": "origin/ka_master_20260824",',
      '    },',
      '    "meego-ipd": {',
      '      "url": "git@code.byted.org:dc/meego-ipd.git",',
      '      "branch": "fix/save-btn-state",',
      '      "from": "origin/ka_master_20260824",',
      '    },',
      '  },',
      '}',
      '',
    ].join('\n')

    try {
      await mkdir(resolve(source, 'scripts/nested'), { recursive: true })
      await mkdir(resolve(source, 'docs'), { recursive: true })
      await writeFile(resolve(source, 'task.config.jsonc'), sourceConfig)
      await writeFile(resolve(source, 'scripts/bootstrap.sh'), '#!/bin/sh\necho bootstrap\n')
      await writeFile(resolve(source, 'scripts/nested/check.sh'), '#!/bin/sh\necho check\n')
      await writeFile(resolve(source, 'docs/source-only.md'), 'do not import\n')
      await writeFile(resolve(source, 'AGENTS.md'), 'do not import\n')

      await mkdir(target)
      const initialized = await gits(['-C', target, 'init', '--json'])
      assert.equal(initialized.code, 0)

      const imported = await gits(['-C', target, 'init', '--scan', '../source-task', '--json'])
      assert.equal(imported.code, 0)
      assert.deepEqual(
        parseOutput(imported).repos.map((repository) => repository.name),
        ['project-manager', 'meego-ipd'],
      )
      assert.equal(await readFile(resolve(target, 'task.config.jsonc'), 'utf8'), sourceConfig)
      assert.equal(
        await readFile(resolve(target, 'scripts/bootstrap.sh'), 'utf8'),
        '#!/bin/sh\necho bootstrap\n',
      )
      assert.equal(
        await readFile(resolve(target, 'scripts/nested/check.sh'), 'utf8'),
        '#!/bin/sh\necho check\n',
      )
      await assert.rejects(() => readFile(resolve(target, 'docs/source-only.md'), 'utf8'))
      assert.equal(await readFile(resolve(target, 'AGENTS.md'), 'utf8'), '')
      assert.equal(await readFile(resolve(source, 'task.config.jsonc'), 'utf8'), sourceConfig)
      assert.equal(
        await readFile(resolve(source, 'scripts/bootstrap.sh'), 'utf8'),
        '#!/bin/sh\necho bootstrap\n',
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

async function gits(args: readonly string[]): Promise<CommandResponse> {
  return run(process.execPath, ['--import=tsx', cliEntry, ...args], repositoryRoot)
}

async function git(args: readonly string[], cwd: string): Promise<CommandResponse> {
  return run('git', args, cwd)
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<CommandResponse> {
  try {
    const response = await executeFile(command, args, { cwd, encoding: 'utf8' })
    return { code: 0, stderr: String(response.stderr), stdout: String(response.stdout) }
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
  await writeFile(resolve(seed, 'README.md'), 'root metadata\n')
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
  checkout?: readonly string[],
): Promise<void> {
  const config = {
    repos: {
      api: {
        url: pathToFileURL(remote).href,
        branch: 'feat/task-1',
        ...(checkout === undefined ? {} : { checkout }),
        from: 'origin/main',
      },
    },
  }
  await writeFile(resolve(task, 'task.config.jsonc'), `${JSON.stringify(config, null, 2)}\n`)
}

function parseOutput(response: CommandResponse): JsonCommandOutput {
  const output = JSON.parse(response.stdout) as JsonCommandOutput
  assert.deepEqual(Object.keys(output).toSorted(), ['command', 'ok', 'repos'])
  return output
}
