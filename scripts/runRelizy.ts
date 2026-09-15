import { execFile, spawn } from 'node:child_process'
import { resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolvePath(import.meta.dirname, '..')
const releaseArguments = process.argv.slice(2)

if (!(await hasVersionTag()) && !hasExplicitFrom(releaseArguments)) {
  const firstCommit = await gitOutput(['rev-list', '--max-parents=0', 'HEAD'])
  releaseArguments.push('--from', firstCommit)
  process.stdout.write(
    `No version tag exists yet; Relizy will use the first commit ${firstCommit.slice(0, 8)} as its initial baseline.\n`
  )
}

const exitCode = await runRelizy(releaseArguments)
process.exitCode = exitCode

async function gitOutput(arguments_: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf-8',
  })
  return stdout.trim()
}

async function hasVersionTag(): Promise<boolean> {
  const tags = await gitOutput(['tag', '--list', 'v[0-9]*'])
  return tags.length > 0
}

function hasExplicitFrom(arguments_: readonly string[]): boolean {
  return arguments_.some(
    (argument) => argument === '--from' || argument.startsWith('--from=')
  )
}

async function runRelizy(arguments_: readonly string[]): Promise<number> {
  const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const child = spawn(
    executable,
    ['exec', 'relizy', 'release', ...arguments_],
    {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'inherit',
    }
  )

  return new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal !== null) {
        process.stderr.write(`Relizy was terminated by ${signal}.\n`)
      }
      resolve(code ?? 1)
    })
  })
}
