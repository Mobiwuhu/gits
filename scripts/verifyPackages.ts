import { execFile } from 'node:child_process'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '..')
const sourceCondition = '@usegit/source'

interface ConditionalExportTarget {
  readonly '@usegit/source'?: string
  readonly default?: string
  readonly types?: string
}

interface PackageExports {
  readonly '.'?: ConditionalExportTarget
}

interface PackageManifest {
  readonly bin?: Readonly<Record<string, string>>
  readonly dependencies?: Readonly<Record<string, string>>
  readonly exports?: PackageExports
  readonly files?: readonly string[]
  readonly license?: string
  readonly name: string
  readonly private?: boolean
  readonly publishConfig?: unknown
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

assertEqual(cliPackage.name, '@usegit/cli', 'CLI package name')
assertEqual(corePackage.name, '@usegit/core', 'Core package name')
assertEqual(cliPackage.version, rootPackage.version, 'CLI and root versions')
assertEqual(corePackage.version, rootPackage.version, 'Core and root versions')
assertEqual(rootPackage.license, 'Apache-2.0', 'root package license')
assertEqual(cliPackage.license, 'Apache-2.0', 'CLI package license')
assertEqual(corePackage.license, 'Apache-2.0', 'Core package license')
assertPublishable(cliPackage)
assertPublishable(corePackage)
assertEqual(
  cliPackage.files?.join(','),
  'dist,LICENSE,NOTICE',
  'CLI published files'
)
assertEqual(cliPackage.bin?.gits, './dist/index.js', 'CLI binary')
assertEqual(cliPackage.publishConfig, undefined, 'CLI publishConfig')
assertEqual(
  corePackage.files?.join(','),
  'dist,src/**/*.ts,!src/**/*.test.ts,templates,LICENSE,NOTICE',
  'Core published files'
)
assertEqual(corePackage.publishConfig, undefined, 'Core publishConfig')
assertCoreExports(corePackage, 'Core source manifest')

const sourceCoreResolution = await resolveCore(true)
assertEqual(
  sourceCoreResolution,
  pathToFileURL(resolve(coreDirectory, 'src/index.ts')).href,
  'Core source-condition resolution'
)
const defaultCoreResolution = await resolveCore(false)
assertEqual(
  defaultCoreResolution,
  pathToFileURL(resolve(coreDirectory, 'dist/index.js')).href,
  'Core default resolution'
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
    Object.keys(packedCli.dependencies ?? {}).length,
    0,
    'packed CLI runtime dependency count'
  )
  assertEqual(packedCli.bin?.gits, './dist/index.js', 'packed CLI binary')
  assertEqual(packedCli.publishConfig, undefined, 'packed CLI publishConfig')
  assertEqual(packedCore.publishConfig, undefined, 'packed Core publishConfig')
  assertCoreExports(packedCore, 'packed Core manifest')
  assertPublishable(packedCli)
  assertPublishable(packedCore)

  const cliFiles = await archiveFiles(cliArchive)
  const coreFiles = await archiveFiles(coreArchive)
  assertIncludes(cliFiles, 'package/dist/index.js', 'CLI runtime')
  assertIncludes(cliFiles, 'package/LICENSE', 'CLI license')
  assertIncludes(cliFiles, 'package/NOTICE', 'CLI attribution notice')
  assertIncludes(coreFiles, 'package/dist/index.js', 'Core runtime')
  assertIncludes(coreFiles, 'package/LICENSE', 'Core license')
  assertIncludes(coreFiles, 'package/NOTICE', 'Core attribution notice')
  assertIncludes(coreFiles, 'package/dist/index.d.ts', 'Core declarations')
  assertIncludes(coreFiles, 'package/src/index.ts', 'Core source entry')
  assertIncludes(
    coreFiles,
    'package/templates/taskScaffold.md',
    'Core source templates'
  )
  assertIncludes(
    coreFiles,
    'package/dist/templates/taskScaffold.md',
    'Core templates'
  )
  assertNoMatch(cliFiles, /(?:^|\/)src\//u, 'CLI source files')
  assertNoMatch(cliFiles, /\.test\.[cm]?[jt]sx?$/u, 'CLI test files')
  assertNoMatch(coreFiles, /\.test\.[cm]?[jt]sx?$/u, 'Core test files')

  const consumerDirectory = resolve(temporaryDirectory, 'consumer')
  await writeFile(
    resolve(temporaryDirectory, 'consumer-package.json'),
    `${JSON.stringify(
      {
        dependencies: {
          '@usegit/cli': `file:${cliArchive}`,
          '@usegit/core': `file:${coreArchive}`,
        },
        name: 'gits-package-consumer',
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
  const initializedTask = resolve(temporaryDirectory, 'initialized-task')
  await mkdir(initializedTask)
  await run(
    'pnpm',
    ['exec', 'gits', '-C', initializedTask, 'init', '--json'],
    consumerDirectory
  )
  await readFile(resolve(initializedTask, 'task.config.jsonc'), 'utf-8')
  const standaloneDirectory = resolve(temporaryDirectory, 'standalone-worker')
  const standaloneWorker = resolve(
    standaloneDirectory,
    'repo-mirror-worker.mjs'
  )
  await mkdir(standaloneDirectory)
  await copyFile(resolve(cliDirectory, 'dist/index.js'), standaloneWorker)
  const workerVersion = await run(
    process.execPath,
    [standaloneWorker, '--version'],
    standaloneDirectory,
    { GITS_SCHEDULER_WORKER: '1' }
  )
  assertEqual(
    workerVersion.trim(),
    rootPackage.version,
    'standalone scheduler worker version'
  )
  const lifecycleHome = resolve(temporaryDirectory, 'lifecycle-home')
  const lifecycleBin = resolve(lifecycleHome, 'bin')
  const lifecycleRunner = resolve(lifecycleBin, 'gits-repo-mirror-runner.cjs')
  const lifecycleWorker = resolve(lifecycleBin, 'gits-repo-mirror-worker.mjs')
  const globalBin = resolve(temporaryDirectory, 'global-bin')
  const globalCommand = resolve(globalBin, 'gits')
  await mkdir(lifecycleBin, { recursive: true })
  await mkdir(globalBin)
  await writeFile(lifecycleRunner, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  await symlink(
    resolve(consumerDirectory, 'node_modules/@usegit/cli/dist/index.js'),
    globalCommand
  )
  const refreshedVersion = await run(
    globalCommand,
    ['--version'],
    consumerDirectory,
    { GITS_HOME: lifecycleHome }
  )
  assertEqual(
    refreshedVersion.trim(),
    rootPackage.version,
    'CLI version through an npm-style global symlink'
  )
  const runnerVersion = await run(
    lifecycleRunner,
    ['--version'],
    temporaryDirectory,
    { GITS_HOME: lifecycleHome }
  )
  assertEqual(
    runnerVersion.trim(),
    rootPackage.version,
    'refreshed stable scheduler runner version'
  )
  const lifecycleRunnerContent = await readFile(lifecycleRunner, 'utf-8')
  if (lifecycleRunnerContent.includes(consumerDirectory)) {
    throw new Error('stable scheduler runner references the package install')
  }

  await rm(resolve(consumerDirectory, 'node_modules'), {
    force: true,
    recursive: true,
  })
  const uninstalledVersion = await run(
    lifecycleRunner,
    ['--version'],
    temporaryDirectory,
    { GITS_HOME: lifecycleHome }
  )
  assertEqual(
    uninstalledVersion.trim(),
    rootPackage.version,
    'scheduler runner after package removal'
  )

  await run(
    'pnpm',
    ['install', '--ignore-scripts', '--no-frozen-lockfile'],
    consumerDirectory
  )
  await writeFile(lifecycleWorker, 'damaged worker\n')
  await run(globalCommand, ['--version'], consumerDirectory, {
    GITS_HOME: lifecycleHome,
  })
  const reinstalledVersion = await run(
    lifecycleRunner,
    ['--version'],
    temporaryDirectory,
    { GITS_HOME: lifecycleHome }
  )
  assertEqual(
    reinstalledVersion.trim(),
    rootPackage.version,
    'scheduler runner repaired after package reinstall'
  )
  await run(
    'node',
    [
      '--input-type=module',
      '--eval',
      "const core = await import('@usegit/core'); if (Object.keys(core).length === 0) process.exit(1)",
    ],
    consumerDirectory
  )
  await run(
    process.execPath,
    [
      `--conditions=${sourceCondition}`,
      '--input-type=module',
      '--eval',
      "const url = import.meta.resolve('@usegit/core'); if (!url.endsWith('/src/index.ts')) process.exit(1)",
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
}

function assertCoreExports(
  packageManifest: PackageManifest,
  label: string
): void {
  const rootExport = packageManifest.exports?.['.']
  assertEqual(
    Object.keys(rootExport ?? {}).join(','),
    `${sourceCondition},types,default`,
    `${label} condition order`
  )
  assertEqual(
    rootExport?.[sourceCondition],
    './src/index.ts',
    `${label} source condition`
  )
  assertEqual(rootExport?.types, './dist/index.d.ts', `${label} declarations`)
  assertEqual(
    rootExport?.default,
    './dist/index.js',
    `${label} default runtime`
  )
}

async function resolveCore(useSource: boolean): Promise<string> {
  const arguments_ = [
    ...(useSource ? [`--conditions=${sourceCondition}`, '--import=tsx'] : []),
    '--input-type=module',
    '--eval',
    `const url = import.meta.resolve('@usegit/core'); await import('@usegit/core'); process.stdout.write(url)`,
  ]
  return (
    await run(process.execPath, arguments_, cliDirectory, {
      TSX_TSCONFIG_PATH: resolve(repositoryRoot, 'tsconfig.base.json'),
    })
  ).trim()
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
  cwd: string,
  environment: NodeJS.ProcessEnv = {}
): Promise<string> {
  const { stdout } = await execFileAsync(command, arguments_, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...environment },
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout
}
