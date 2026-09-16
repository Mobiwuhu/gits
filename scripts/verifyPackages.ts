import { execFile } from 'node:child_process'
import {
  copyFile,
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

interface PackageManifest {
  readonly bin?: Readonly<Record<string, string>>
  readonly dependencies?: Readonly<Record<string, string>>
  readonly exports?: string
  readonly files?: readonly string[]
  readonly name: string
  readonly private?: boolean
  readonly publishConfig?: {
    readonly access?: string
    readonly bin?: Readonly<Record<string, string>>
    readonly exports?: string
    readonly types?: string
  }
  readonly types?: string
  readonly version: string
}

const rootPackage = await readJson<PackageManifest>(
  resolve(repositoryRoot, 'package.json')
)
const cliDirectory = resolve(repositoryRoot, 'apps/cli')
const coreDirectory = resolve(repositoryRoot, 'packages/core')
const cliPackage = await readJson<PackageManifest>(
  resolve(cliDirectory, 'package.json')
)
const corePackage = await readJson<PackageManifest>(
  resolve(coreDirectory, 'package.json')
)

assertEqual(cliPackage.name, '@gits/cli', 'CLI package name')
assertEqual(corePackage.name, '@gits/core', 'Core package name')
assertEqual(cliPackage.version, rootPackage.version, 'CLI and root versions')
assertEqual(corePackage.version, rootPackage.version, 'Core and root versions')
assertPublishable(cliPackage)
assertPublishable(corePackage)
assertEqual(cliPackage.files?.join(','), 'dist', 'CLI published files')
assertEqual(cliPackage.bin?.gits, './dev.mjs', 'CLI development binary')
assertEqual(
  cliPackage.publishConfig?.bin?.gits,
  './dist/index.js',
  'CLI published binary'
)
assertEqual(corePackage.exports, './src/index.ts', 'Core development export')
assertEqual(
  corePackage.publishConfig?.exports,
  './dist/index.js',
  'Core published export'
)
assertEqual(
  corePackage.publishConfig?.types,
  './dist/index.d.ts',
  'Core published declarations'
)

const temporaryDirectory = await mkdtemp(
  resolve(tmpdir(), 'gits-package-audit-')
)

try {
  const cliArchive = await pack(cliDirectory, temporaryDirectory)
  const coreArchive = await pack(coreDirectory, temporaryDirectory)
  const packedCli = await readArchiveManifest(cliArchive)
  const packedCore = await readArchiveManifest(coreArchive)

  assertEqual(packedCli.name, cliPackage.name, 'packed CLI name')
  assertEqual(packedCore.name, corePackage.name, 'packed Core name')
  assertEqual(packedCli.version, rootPackage.version, 'packed CLI version')
  assertEqual(packedCore.version, rootPackage.version, 'packed Core version')
  assertEqual(
    packedCli.dependencies?.['@gits/core'],
    rootPackage.version,
    'packed CLI dependency on Core'
  )
  assertEqual(packedCli.bin?.gits, './dist/index.js', 'packed CLI binary')
  assertEqual(packedCore.exports, './dist/index.js', 'packed Core export')
  assertEqual(packedCore.types, './dist/index.d.ts', 'packed Core declarations')
  assertPublishable(packedCli)
  assertPublishable(packedCore)

  const cliFiles = await archiveFiles(cliArchive)
  const coreFiles = await archiveFiles(coreArchive)
  assertIncludes(cliFiles, 'package/dist/index.js', 'CLI runtime')
  assertIncludes(coreFiles, 'package/dist/index.js', 'Core runtime')
  assertIncludes(coreFiles, 'package/dist/index.d.ts', 'Core declarations')
  assertIncludes(
    coreFiles,
    'package/dist/templates/taskScaffold.md',
    'Core templates'
  )
  assertNoMatch(cliFiles, /(?:^|\/)src\//u, 'CLI source files')
  assertNoMatch(coreFiles, /(?:^|\/)src\//u, 'Core source files')
  assertNoMatch(cliFiles, /\.test\.[cm]?[jt]sx?$/u, 'CLI test files')

  const consumerDirectory = resolve(temporaryDirectory, 'consumer')
  await writeFile(
    resolve(temporaryDirectory, 'consumer-package.json'),
    `${JSON.stringify(
      {
        dependencies: {
          '@gits/cli': `file:${cliArchive}`,
          '@gits/core': `file:${coreArchive}`,
        },
        name: 'gits-package-consumer',
        pnpm: {
          overrides: {
            '@gits/core': `file:${coreArchive}`,
          },
        },
        private: true,
        type: 'module',
        version: '0.0.0',
      },
      null,
      2
    )}\n`
  )
  await mkdir(consumerDirectory)
  await copyFile(
    resolve(temporaryDirectory, 'consumer-package.json'),
    resolve(consumerDirectory, 'package.json')
  )
  await run(
    'pnpm',
    ['install', '--ignore-scripts', '--no-frozen-lockfile'],
    consumerDirectory
  )

  const cliVersion = await run(
    'pnpm',
    ['exec', 'gits', '--version'],
    consumerDirectory
  )
  assertEqual(cliVersion.trim(), rootPackage.version, 'installed CLI version')
  await run('pnpm', ['exec', 'gits', '--help'], consumerDirectory)
  await run(
    'node',
    [
      '--input-type=module',
      '--eval',
      "const core = await import('@gits/core'); if (Object.keys(core).length === 0) process.exit(1)",
    ],
    consumerDirectory
  )

  process.stdout.write(
    `Package verification passed for ${cliPackage.name} and ${corePackage.name} ${rootPackage.version}.\n`
  )
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true })
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    )
  }
}

function assertIncludes(
  values: readonly string[],
  expected: string,
  label: string
): void {
  if (!values.includes(expected)) {
    throw new Error(`${label}: ${expected} is missing from the archive`)
  }
}

function assertNoMatch(
  values: readonly string[],
  pattern: RegExp,
  label: string
): void {
  const match = values.find((value) => pattern.test(value))
  if (match !== undefined) {
    throw new Error(`${label}: unexpected archive entry ${match}`)
  }
}

function assertPublishable(packageManifest: PackageManifest): void {
  if (packageManifest.private === true) {
    throw new Error(`${packageManifest.name} must not be private`)
  }
  assertEqual(
    packageManifest.publishConfig?.access,
    'public',
    `${packageManifest.name} access`
  )
}

async function archiveFiles(archive: string): Promise<readonly string[]> {
  const contents = await run('tar', ['-tzf', archive], repositoryRoot)
  return contents.split('\n').filter((entry) => entry.length > 0)
}

async function pack(
  packageDirectory: string,
  destination: string
): Promise<string> {
  const before = new Set(await readdir(destination))
  await run(
    'pnpm',
    ['pack', '--pack-destination', destination],
    packageDirectory
  )
  const destinationEntries = await readdir(destination)
  const archives = destinationEntries.filter(
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
  const contents = await run(
    'tar',
    ['-xOf', archive, 'package/package.json'],
    repositoryRoot
  )
  return JSON.parse(contents) as PackageManifest
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T
}

async function run(
  command: string,
  arguments_: readonly string[],
  cwd: string
): Promise<string> {
  const { stdout } = await execFileAsync(command, arguments_, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout
}
