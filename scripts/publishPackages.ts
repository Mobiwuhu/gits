import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '..')
const npmRegistry = 'https://registry.npmjs.org/'
const cliPackageName = '@usegits/cli'
const corePackageName = '@usegits/core'

interface CommandOptions {
  readonly dryRun: boolean
  readonly tag: string
}

interface PackageManifest {
  dependencies?: Record<string, string>
  name: string
  version: string
}

interface PublishTarget {
  readonly archive: string
  readonly name: string
  readonly version: string
}

const options = parseOptions(process.argv.slice(2))
const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'gits-npm-publish-'))

try {
  const rootPackage = await readManifest(
    resolve(repositoryRoot, 'package.json')
  )
  const coreArchive = await pack(
    resolve(repositoryRoot, 'packages/core'),
    temporaryDirectory
  )
  const cliArchive = await pack(
    resolve(repositoryRoot, 'apps/cli'),
    temporaryDirectory
  )
  const packedCore = await readArchiveManifest(coreArchive)
  const packedCli = await readArchiveManifest(cliArchive)
  assertEqual(packedCore.name, corePackageName, 'Core package name')
  assertEqual(packedCli.name, cliPackageName, 'CLI package name')
  assertEqual(packedCore.version, rootPackage.version, 'Core package version')
  assertEqual(packedCli.version, rootPackage.version, 'CLI package version')

  const targets: readonly PublishTarget[] = [
    {
      archive: coreArchive,
      name: corePackageName,
      version: rootPackage.version,
    },
    {
      archive: cliArchive,
      name: cliPackageName,
      version: rootPackage.version,
    },
  ]
  const publishedVersions = options.dryRun
    ? targets.map(() => false)
    : await Promise.all(
        targets.map((target) => isPublished(target, npmRegistry))
      )
  const pendingTargets = targets.filter((target, index) => {
    if (publishedVersions[index] === true) {
      process.stdout.write(
        `${target.name}@${target.version} already exists on npm; skipping it.\n`
      )
      return false
    }
    return true
  })

  for (const target of pendingTargets) {
    // Keep each package's output together.
    // eslint-disable-next-line no-await-in-loop
    await publish(target.archive, npmRegistry, options.tag, true)
  }

  if (options.dryRun) {
    process.stdout.write(`npm dry run passed for ${rootPackage.version}.\n`)
  } else {
    for (const target of pendingTargets) {
      // Publish Core before the CLI in a deterministic order.
      // eslint-disable-next-line no-await-in-loop
      await publish(target.archive, npmRegistry, options.tag, false)
    }
    process.stdout.write(
      pendingTargets.length === 0
        ? `All npm packages are already published at ${rootPackage.version}.\n`
        : `Published npm packages at ${rootPackage.version}.\n`
    )
  }
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true })
}

function parseOptions(arguments_: readonly string[]): CommandOptions {
  let dryRun = false
  let tag = 'latest'

  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index]
    if (flag === '--dry-run') {
      dryRun = true
      continue
    }
    if (flag === '--tag') {
      const value = arguments_[index + 1]
      if (value === undefined || value.startsWith('-')) {
        throw new Error('--tag requires a value')
      }
      tag = value
      index += 1
      continue
    }
    throw new Error(`Unknown publish option: ${flag ?? ''}`)
  }

  return { dryRun, tag }
}

async function isPublished(
  target: PublishTarget,
  registry: string
): Promise<boolean> {
  try {
    const output = await runCapture('pnpm', [
      'view',
      `${target.name}@${target.version}`,
      'version',
      '--registry',
      registry,
    ])
    return output.trim() === target.version
  } catch (error) {
    if (errorText(error).includes('E404')) {
      return false
    }
    throw error
  }
}

async function publish(
  archive: string,
  registry: string,
  tag: string,
  dryRun: boolean
): Promise<void> {
  const arguments_ = [
    'publish',
    archive,
    '--registry',
    registry,
    '--access',
    'public',
    '--tag',
    tag,
    '--ignore-scripts',
  ]
  if (dryRun) {
    arguments_.push('--dry-run')
  }
  await runInteractive('npm', arguments_)
}

async function pack(
  packageDirectory: string,
  destination: string
): Promise<string> {
  const before = new Set(await readdir(destination))
  await runCapture(
    'pnpm',
    ['pack', '--pack-destination', destination],
    packageDirectory
  )
  const archives = (await readdir(destination)).filter(
    (entry) => entry.endsWith('.tgz') && !before.has(entry)
  )
  if (archives.length !== 1 || archives[0] === undefined) {
    throw new Error(
      `Expected one archive from ${packageDirectory}, got ${archives.length}`
    )
  }
  return resolve(destination, archives[0])
}

async function readArchiveManifest(archive: string): Promise<PackageManifest> {
  const contents = await runCapture('tar', [
    '-xOf',
    archive,
    'package/package.json',
  ])
  return parseManifest(contents)
}

async function readManifest(path: string): Promise<PackageManifest> {
  return parseManifest(await readFile(path, 'utf-8'))
}

function parseManifest(contents: string): PackageManifest {
  const value: unknown = JSON.parse(contents)
  if (!isPackageManifest(value)) {
    throw new Error('Invalid package manifest')
  }
  return value
}

function isPackageManifest(value: unknown): value is PackageManifest {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.version !== 'string'
  ) {
    return false
  }
  return (
    value.dependencies === undefined ||
    (isRecord(value.dependencies) &&
      Object.values(value.dependencies).every(
        (dependency) => typeof dependency === 'string'
      ))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function runCapture(
  command: string,
  arguments_: readonly string[],
  cwd = repositoryRoot
): Promise<string> {
  const { stdout } = await execFileAsync(command, arguments_, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout
}

async function runInteractive(
  command: string,
  arguments_: readonly string[]
): Promise<void> {
  const child = spawn(command, arguments_, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
  })

  await new Promise<void>((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      rejectPromise(
        new Error(
          signal === null
            ? `${command} exited with code ${code ?? 1}`
            : `${command} was terminated by ${signal}`
        )
      )
    })
  })
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    )
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const stderr = 'stderr' in error ? String(error.stderr) : ''
    return `${error.message}\n${stderr}`
  }
  return String(error)
}
