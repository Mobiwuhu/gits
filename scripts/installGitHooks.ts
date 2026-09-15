import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '..')
const hooksPath = await readGitHooksPath()

if (hooksPath === undefined) {
  await installLefthook()
} else if (isAbsolute(hooksPath) && (await chainsRepositoryHooks(hooksPath))) {
  const localHooksPath = resolve(repositoryRoot, '.git/hooks')
  process.stdout.write(
    `Existing hook manager at ${hooksPath} chains repository hooks; installing Lefthook into ${localHooksPath}.\n`
  )
  await installLefthook(localHooksPath)
} else {
  process.stderr.write(
    `Lefthook was not installed because core.hooksPath is already set to ${hooksPath}. ` +
      'Keep that hook manager, and make it invoke the repository .git/hooks scripts before committing.\n'
  )
}

async function chainsRepositoryHooks(path: string): Promise<boolean> {
  const helper = await readOptional(resolve(path, 'utils'))
  const helperChainsLocalHooks = helper.includes('.git/hooks/')

  return (
    (await stageChainsRepositoryHook(
      path,
      'pre-commit',
      helperChainsLocalHooks
    )) &&
    (await stageChainsRepositoryHook(
      path,
      'commit-msg',
      helperChainsLocalHooks
    ))
  )
}

async function installLefthook(overriddenHooksPath?: string): Promise<void> {
  const environment = { ...process.env }
  const arguments_ = ['exec', 'lefthook', 'install']

  if (overriddenHooksPath !== undefined) {
    const configCount = Math.trunc(Number(environment.GIT_CONFIG_COUNT ?? '0'))
    environment.GIT_CONFIG_COUNT = String(configCount + 1)
    environment[`GIT_CONFIG_KEY_${configCount}`] = 'core.hooksPath'
    environment[`GIT_CONFIG_VALUE_${configCount}`] = overriddenHooksPath
    arguments_.push('--force')
  }

  await execFileAsync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    arguments_,
    {
      cwd: repositoryRoot,
      env: environment,
    }
  )
}

async function readGitHooksPath(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['config', '--get', 'core.hooksPath'],
      {
        cwd: repositoryRoot,
        encoding: 'utf-8',
      }
    )
    const value = stdout.trim()
    return value.length === 0 ? undefined : value
  } catch (error) {
    if (isExitCode(error, 1)) {
      return undefined
    }
    throw error
  }
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return ''
  }
}

async function stageChainsRepositoryHook(
  customHooksPath: string,
  stage: string,
  helperChainsLocalHooks: boolean
): Promise<boolean> {
  const hook = await readOptional(resolve(customHooksPath, stage))
  return (
    hook.includes(`.git/hooks/${stage}`) ||
    (hook.includes('chain_local_hook') && helperChainsLocalHooks)
  )
}

function isExitCode(error: unknown, expected: number): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === expected
  )
}
