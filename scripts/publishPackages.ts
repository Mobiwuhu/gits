import { execFile, spawn } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '..')

enum PublishChannel {
  Internal = 'internal',
  Npm = 'npm',
}

interface ChannelConfiguration {
  readonly cliPackageName: string
  readonly corePackageName: string
  readonly registry: string
}

interface CommandOptions {
  readonly channel: PublishChannel
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
const configuration = await readChannelConfiguration(options)
const temporaryDirectory = await mkdtemp(
  resolve(tmpdir(), `gits-${options.channel}-publish-`)
)

try {
  const rootPackage = await readManifest(
    resolve(repositoryRoot, 'package.json')
  )
  const sourceArchivesDirectory = resolve(temporaryDirectory, 'source-archives')
  const channelArchivesDirectory = resolve(
    temporaryDirectory,
    'channel-archives'
  )
  await mkdir(sourceArchivesDirectory)
  await mkdir(channelArchivesDirectory)

  const sourceCoreArchive = await pack(
    resolve(repositoryRoot, 'packages/core'),
    sourceArchivesDirectory
  )
  const sourceCliArchive = await pack(
    resolve(repositoryRoot, 'apps/cli'),
    sourceArchivesDirectory
  )
  const coreArchive = await createChannelArchive({
    destination: channelArchivesDirectory,
    name: configuration.corePackageName,
    sourceArchive: sourceCoreArchive,
    stagingDirectory: resolve(temporaryDirectory, 'core'),
    version: rootPackage.version,
  })
  const cliArchive = await createChannelArchive({
    corePackageName: configuration.corePackageName,
    destination: channelArchivesDirectory,
    name: configuration.cliPackageName,
    sourceArchive: sourceCliArchive,
    stagingDirectory: resolve(temporaryDirectory, 'cli'),
    version: rootPackage.version,
  })
  const targets: readonly PublishTarget[] = [
    {
      archive: coreArchive,
      name: configuration.corePackageName,
      version: rootPackage.version,
    },
    {
      archive: cliArchive,
      name: configuration.cliPackageName,
      version: rootPackage.version,
    },
  ]
  const publishedVersions = options.dryRun
    ? targets.map(() => false)
    : await Promise.all(
        targets.map((target) => isPublished(target, configuration.registry))
      )
  const pendingTargets = targets.filter((target, index) => {
    if (publishedVersions[index] === true) {
      process.stdout.write(
        `${target.name}@${target.version} already exists in ${options.channel}; skipping it.\n`
      )
      return false
    }
    return true
  })

  for (const target of pendingTargets) {
    // Keep each package's dry-run output together.
    // eslint-disable-next-line no-await-in-loop
    await publish(target.archive, configuration.registry, options.tag, true)
  }

  if (options.dryRun) {
    process.stdout.write(
      `Dry run passed for ${options.channel} (${rootPackage.version}).\n`
    )
  } else {
    for (const target of pendingTargets) {
      // Publish Core before the CLI that depends on it.
      // eslint-disable-next-line no-await-in-loop
      await publish(target.archive, configuration.registry, options.tag, false)
    }
    process.stdout.write(
      pendingTargets.length === 0
        ? `All ${options.channel} packages are already published at ${rootPackage.version}.\n`
        : `Published ${options.channel} packages at ${rootPackage.version}.\n`
    )
  }
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true })
}

function parseOptions(arguments_: readonly string[]): CommandOptions {
  const [channelArgument, ...flags] = arguments_
  const channel = parseChannel(channelArgument)
  let dryRun = false
  let tag = 'latest'

  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]
    if (flag === '--dry-run') {
      dryRun = true
      continue
    }
    if (flag === '--tag') {
      const value = flags[index + 1]
      if (value === undefined || value.startsWith('-')) {
        throw new Error('--tag requires a value')
      }
      tag = value
      index += 1
      continue
    }
    throw new Error(`Unknown publish option: ${flag ?? ''}`)
  }

  return { channel, dryRun, tag }
}

function parseChannel(value: string | undefined): PublishChannel {
  switch (value) {
    case PublishChannel.Internal:
      return PublishChannel.Internal
    case PublishChannel.Npm:
      return PublishChannel.Npm
    default:
      throw new Error(
        'Usage: publishPackages.ts <internal|npm> [--dry-run] [--tag <tag>]'
      )
  }
}

async function readChannelConfiguration(
  options_: CommandOptions
): Promise<ChannelConfiguration> {
  const filename = options_.dryRun
    ? '.publish.example.json'
    : '.publish.local.json'
  let contents: string

  try {
    contents = await readFile(resolve(repositoryRoot, filename), 'utf-8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        'Create .publish.local.json from .publish.example.json and configure the release channels before publishing.',
        { cause: error }
      )
    }
    throw error
  }

  const value: unknown = JSON.parse(contents)
  if (!isRecord(value)) {
    throw new Error('Invalid publish configuration')
  }
  const channelConfiguration = value[options_.channel]
  if (!isChannelConfiguration(channelConfiguration)) {
    throw new Error(`Invalid publish configuration for ${options_.channel}`)
  }
  return channelConfiguration
}

function isChannelConfiguration(value: unknown): value is ChannelConfiguration {
  return (
    isRecord(value) &&
    typeof value.cliPackageName === 'string' &&
    typeof value.corePackageName === 'string' &&
    typeof value.registry === 'string'
  )
}

async function createChannelArchive(options_: {
  readonly corePackageName?: string
  readonly destination: string
  readonly name: string
  readonly sourceArchive: string
  readonly stagingDirectory: string
  readonly version: string
}): Promise<string> {
  await mkdir(options_.stagingDirectory)
  await runCapture('tar', [
    '-xzf',
    options_.sourceArchive,
    '-C',
    options_.stagingDirectory,
  ])

  const packageDirectory = resolve(options_.stagingDirectory, 'package')
  const manifestPath = resolve(packageDirectory, 'package.json')
  const manifest = await readManifest(manifestPath)
  assertEqual(manifest.version, options_.version, `${manifest.name} version`)
  manifest.name = options_.name

  if (options_.corePackageName !== undefined) {
    if (manifest.dependencies?.['@gits/core'] === undefined) {
      throw new Error(`${manifest.name} does not depend on @gits/core`)
    }
    manifest.dependencies['@gits/core'] =
      `npm:${options_.corePackageName}@${options_.version}`
  }

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const archive = await pack(packageDirectory, options_.destination)
  const packedManifest = await readArchiveManifest(archive)
  assertEqual(packedManifest.name, options_.name, 'channel package name')
  assertEqual(
    packedManifest.version,
    options_.version,
    'channel package version'
  )

  if (options_.corePackageName !== undefined) {
    assertEqual(
      packedManifest.dependencies?.['@gits/core'],
      `npm:${options_.corePackageName}@${options_.version}`,
      'channel Core alias'
    )
  }

  return archive
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
    '--no-git-checks',
    '--ignore-scripts',
  ]
  if (dryRun) {
    arguments_.push('--dry-run')
  }
  await runInteractive('pnpm', arguments_)
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
