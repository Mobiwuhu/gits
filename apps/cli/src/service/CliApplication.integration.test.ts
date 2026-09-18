import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
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
  '../../../..'
)
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

void describe('gits CLI', () => {
  void it('creates an idempotent scaffold and reports incomplete configuration before Git work', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-init-test-'))
    const task = resolve(root, 'task')
    await mkdir(task)

    try {
      const initialized = await gits(['-C', task, 'init', '--json'])
      assert.equal(initialized.code, 0)
      assert.deepEqual(parseOutput(initialized).repos, [])
      assert.match(
        await readFile(resolve(task, 'AGENTS.md'), 'utf-8'),
        /临时任务工作区/u
      )
      assert.match(
        await readFile(resolve(task, 'docs/AGENTS.md'), 'utf-8'),
        /任务范围内的知识/u
      )
      assert.match(
        await readFile(resolve(task, 'scripts/AGENTS.md'), 'utf-8'),
        /可复用自动化脚本/u
      )
      assert.match(
        await readFile(resolve(task, 'repos/AGENTS.md'), 'utf-8'),
        /独立 Git 仓库/u
      )

      await writeFile(resolve(task, 'AGENTS.md'), 'preserve this content\n')
      await writeFile(
        resolve(task, 'docs/AGENTS.md'),
        'preserve docs content\n'
      )
      await writeFile(
        resolve(task, 'scripts/AGENTS.md'),
        'preserve scripts content\n'
      )
      await writeFile(
        resolve(task, 'repos/AGENTS.md'),
        'preserve repos content\n'
      )
      const repeated = await gits(['-C', task, 'init', '--json'])
      assert.equal(repeated.code, 0)
      assert.equal(
        await readFile(resolve(task, 'AGENTS.md'), 'utf-8'),
        'preserve this content\n'
      )
      assert.equal(
        await readFile(resolve(task, 'docs/AGENTS.md'), 'utf-8'),
        'preserve docs content\n'
      )
      assert.equal(
        await readFile(resolve(task, 'scripts/AGENTS.md'), 'utf-8'),
        'preserve scripts content\n'
      )
      assert.equal(
        await readFile(resolve(task, 'repos/AGENTS.md'), 'utf-8'),
        'preserve repos content\n'
      )

      const incomplete = await gits(['-C', task, 'status', '--json'])
      assert.equal(incomplete.code, 2)
      const output = parseOutput(incomplete)
      assert.equal(output.ok, false)
      assert.equal(output.repos[0]?.state, null)
      assert.equal(output.repos[0]?.error?.code, 'config-incomplete')

      const invalidJobs = await gits([
        '-C',
        task,
        'fetch',
        '--jobs',
        'not-a-number',
        '--json',
      ])
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

  void it('installs, switches, and pushes a task branch through -C', async () => {
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
      const initialUpstream = await git(
        ['rev-parse', '--abbrev-ref', '@{upstream}'],
        resolve(task, 'repos/api')
      )
      assert.notEqual(initialUpstream.code, 0)

      const nestedDirectory = resolve(task, 'docs/nested')
      await mkdir(nestedDirectory, { recursive: true })
      const localOnly = await gits(['-C', nestedDirectory, 'status', '--json'])
      assert.equal(localOnly.code, 0)
      assert.equal(parseOutput(localOnly).repos[0]?.state, 'local-only')

      const pushed = await gits(['-C', task, 'push', 'api', '--json'])
      assert.equal(pushed.code, 0)
      assert.equal(parseOutput(pushed).repos[0]?.state, 'synced-local')
      const pushedUpstream = await git(
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        resolve(task, 'repos/api')
      )
      assert.equal(pushedUpstream.stdout.trim(), 'origin/feat/task-1')

      await git(
        ['config', 'user.email', 'gits@test.invalid'],
        resolve(task, 'repos/api')
      )
      await git(
        ['config', 'user.name', 'gits-test'],
        resolve(task, 'repos/api')
      )
      await git(
        ['commit', '--allow-empty', '-m', 'follow-up'],
        resolve(task, 'repos/api')
      )
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
      assert.equal(
        parseOutput(refusedSwitch).repos[0]?.error?.code,
        'dirty-worktree'
      )

      const stashedSwitch = await gits([
        '-C',
        task,
        'switch',
        '--stash',
        '--json',
      ])
      assert.equal(stashedSwitch.code, 0)
      assert.equal(parseOutput(stashedSwitch).repos[0]?.state, 'synced-local')
      await git(
        ['rev-parse', '--verify', 'refs/stash'],
        resolve(task, 'repos/api')
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('installs, reports, switches, and safely reconciles checkout directories', async () => {
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
      const [installedRepository] = parseOutput(installed).repos
      assert.deepEqual(installedRepository?.expected.checkout, ['knowledge'])
      assert.deepEqual(installedRepository?.actual.checkout, ['knowledge'])
      await access(resolve(repository, 'knowledge/guide.md'))
      await assert.rejects(async () =>
        access(resolve(repository, 'other/application.txt'))
      )
      const installedCheckout = await git(
        ['sparse-checkout', 'list'],
        repository
      )
      assert.equal(installedCheckout.stdout.trim(), 'knowledge')

      await git(
        ['sparse-checkout', 'set', '--cone', '--no-sparse-index', 'other'],
        repository
      )
      const drifted = await gits(['-C', task, 'status', '--json'])
      assert.equal(drifted.code, 1)
      assert.equal(
        parseOutput(drifted).repos[0]?.flags.includes('checkout-different'),
        true
      )

      const reconciled = await gits(['-C', task, 'install', '--json'])
      assert.equal(reconciled.code, 0, reconciled.stderr)
      assert.equal(parseOutput(reconciled).repos[0]?.result, 'success')
      await access(resolve(repository, 'knowledge/guide.md'))
      await assert.rejects(async () =>
        access(resolve(repository, 'other/application.txt'))
      )

      await git(
        ['sparse-checkout', 'set', '--cone', '--no-sparse-index', 'other'],
        repository
      )
      const switched = await gits(['-C', task, 'switch', '--json'])
      assert.equal(switched.code, 0, switched.stderr)
      assert.deepEqual(parseOutput(switched).repos[0]?.actual.checkout, [
        'knowledge',
      ])
      await access(resolve(repository, 'knowledge/guide.md'))

      await writeFile(
        resolve(repository, 'knowledge/guide.md'),
        'locally modified\n'
      )
      await writeTaskConfiguration(task, remote, ['other'])
      const dirty = await gits(['-C', task, 'install', '--json'])
      assert.equal(dirty.code, 1)
      assert.equal(parseOutput(dirty).repos[0]?.error?.code, 'dirty-worktree')
      assert.equal(
        await readFile(resolve(repository, 'knowledge/guide.md'), 'utf-8'),
        'locally modified\n'
      )
      const dirtyCheckout = await git(['sparse-checkout', 'list'], repository)
      assert.equal(dirtyCheckout.stdout.trim(), 'knowledge')

      await git(['reset', '--hard', 'HEAD'], repository)
      await writeTaskConfiguration(task, remote, ['missing-directory'])
      const missing = await gits(['-C', task, 'install', '--json'])
      assert.equal(missing.code, 1)
      assert.equal(
        parseOutput(missing).repos[0]?.error?.code,
        'checkout-path-missing'
      )
      const missingCheckout = await git(['sparse-checkout', 'list'], repository)
      assert.equal(missingCheckout.stdout.trim(), 'knowledge')

      await writeTaskConfiguration(task, remote)
      const expanded = await gits(['-C', task, 'install', '--json'])
      assert.equal(expanded.code, 0, expanded.stderr)
      assert.equal(parseOutput(expanded).repos[0]?.actual.checkout, null)
      await access(resolve(repository, 'other/application.txt'))
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('leaves no repository behind when a configured checkout directory is missing', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-sparse-missing-test-'))

    try {
      const remote = await createRemote(root)
      const task = resolve(root, 'task')
      await mkdir(task)
      await gits(['-C', task, 'init', '--json'])
      await writeTaskConfiguration(task, remote, ['missing-directory'])

      const installed = await gits(['-C', task, 'install', '--json'])
      assert.equal(installed.code, 1)
      assert.equal(
        parseOutput(installed).repos[0]?.error?.code,
        'checkout-path-missing'
      )
      await assert.rejects(async () => access(resolve(task, 'repos/api')))
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('imports every source task entry except repos without modifying the source task', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-scan-test-'))
    const source = resolve(root, 'source-task')
    const target = resolve(root, 'target-task')
    const sourceConfig = [
      '{',
      '  // Imported verbatim from the source task.',
      '  "metadata": { "owner": "platform" },',
      '  "repos": {',
      '    "frontend": {',
      '      "url": "git@github.com:example/frontend.git",',
      '      "branch": "feat/example",',
      '      "from": "origin/main",',
      '    },',
      '    "backend-ipd": {',
      '      "url": "git@github.com:example/backend.git",',
      '      "branch": "feat/example",',
      '      "from": "origin/main",',
      '    },',
      '  },',
      '}',
      '',
    ].join('\n')
    const copiedFiles = [
      ['AGENTS.md', 'task instructions\n'],
      ['docs/AGENTS.md', 'documentation instructions\n'],
      ['docs/source-only.md', 'ordinary documentation\n'],
      ['scripts/AGENTS.md', 'script instructions\n'],
      ['scripts/bootstrap.sh', '#!/bin/sh\necho bootstrap\n'],
      ['scripts/nested/check.sh', '#!/bin/sh\necho check\n'],
      ['.agents/skills/shared/SKILL.md', 'shared skill\n'],
      ['.codex/hooks/preCommit.sh', 'codex hook\n'],
      ['.workspace/settings.json', '{"theme":"dark"}\n'],
      ['justfile', 'dev:\n    pnpm dev\n'],
      ['processCompose.yaml', 'version: "0.5"\n'],
    ] as const

    try {
      await mkdir(source)
      await writeFile(resolve(source, 'task.config.jsonc'), sourceConfig)
      for (const [path, content] of copiedFiles) {
        await mkdir(resolve(source, path, '..'), { recursive: true })
        await writeFile(resolve(source, path), content)
      }
      await mkdir(resolve(source, 'repos/frontend/.git'), {
        recursive: true,
      })
      await writeFile(
        resolve(source, 'repos/AGENTS.md'),
        'source repository instructions\n'
      )
      await writeFile(
        resolve(source, 'repos/frontend/package.json'),
        '{"name":"frontend"}\n'
      )
      await writeFile(
        resolve(source, 'repos/frontend/.git/HEAD'),
        'ref: refs/heads/main\n'
      )

      await mkdir(target)
      const imported = await gits([
        '-C',
        target,
        'init',
        '--scan',
        '../source-task',
        '--json',
      ])
      assert.equal(imported.code, 0)
      assert.deepEqual(
        parseOutput(imported).repos.map((repository) => repository.name),
        ['frontend', 'backend-ipd']
      )
      assert.equal(
        await readFile(resolve(target, 'task.config.jsonc'), 'utf-8'),
        sourceConfig
      )
      for (const [path, content] of copiedFiles) {
        assert.equal(await readFile(resolve(target, path), 'utf-8'), content)
      }
      await assert.rejects(async () =>
        access(resolve(target, 'repos/frontend'))
      )
      assert.match(
        await readFile(resolve(target, 'repos/AGENTS.md'), 'utf-8'),
        /独立 Git 仓库/u
      )
      assert.equal(
        await readFile(resolve(source, 'task.config.jsonc'), 'utf-8'),
        sourceConfig
      )
      assert.equal(
        await readFile(resolve(source, 'repos/frontend/package.json'), 'utf-8'),
        '{"name":"frontend"}\n'
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

async function gits(args: readonly string[]): Promise<CommandResponse> {
  return run(
    process.execPath,
    ['--import=tsx', cliEntry, ...args],
    repositoryRoot
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
  cwd: string
): Promise<CommandResponse> {
  try {
    const response = await executeFile(command, args, {
      cwd,
      encoding: 'utf-8',
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
  checkout?: readonly string[]
): Promise<void> {
  const config = {
    repos: {
      api: {
        branch: 'feat/task-1',
        ...(checkout === undefined ? {} : { checkout }),
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

function parseOutput(response: CommandResponse): JsonCommandOutput {
  const output = JSON.parse(response.stdout) as JsonCommandOutput
  assert.deepEqual(Object.keys(output).toSorted(), ['command', 'ok', 'repos'])
  return output
}
