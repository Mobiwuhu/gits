import { readFile, readdir } from 'node:fs/promises'
import { dirname, extname, relative, resolve, sep } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const sourceRoots = [
  resolve(repositoryRoot, 'apps/cli/src'),
  resolve(repositoryRoot, 'packages/core/src'),
]
const violations: string[] = []
const sourceFileGroups = await Promise.all(sourceRoots.map(listFiles))
const allSourceFiles = sourceFileGroups.flat().toSorted()
const sourceFiles = allSourceFiles.filter(isTypeScriptSource)
const sourceSet = new Set(sourceFiles)
const edges = new Map<string, string[]>()

for (const directory of new Set(sourceFiles.map(dirname))) {
  if (!sourceSet.has(resolve(directory, 'index.ts'))) {
    violations.push(
      `${display(directory)}: source directory is missing index.ts`
    )
  }
}

for (const file of sourceFiles) {
  const content = await readFile(file, 'utf-8')
  const imports = importedSpecifiers(content)
  const resolvedImports: string[] = []

  if (/\bexport\s+default\b/u.test(content)) {
    violations.push(`${display(file)}: default exports are forbidden`)
  }
  if (
    file.endsWith(`${sep}service${sep}index.ts`) &&
    /^export\s+\*/mu.test(content)
  ) {
    violations.push(
      `${display(file)}: service barrels must use named exports to keep the module surface explicit`
    )
  }
  if (isServiceImplementation(file)) {
    if (/\binterface\s+[A-Za-z_$][\w$]*Dependencies\b/u.test(content)) {
      violations.push(
        `${display(file)}: Service dependencies must stay in constructor fields, not dependency bags`
      )
    }
    if (/^(?:async\s+)?function\s+execute[A-Z_$][\w$]*\s*\(/mu.test(content)) {
      violations.push(
        `${display(file)}: Service workflows must be class methods, not detached execute functions`
      )
    }
  }
  for (const match of content.matchAll(
    /@(?<decorator>Inject|Many|Optional)\(\s*(?<identifier>[A-Za-z_$][\w$]*)/gu
  )) {
    const { decorator, identifier } = match.groups ?? {}
    if (identifier !== undefined && !identifier.startsWith('I')) {
      violations.push(
        `${display(file)}: @${decorator ?? 'Inject'} must use an interface Identifier, got ${identifier}`
      )
    }
  }
  for (const match of content.matchAll(
    /@(?<decorator>Inject|Many|Optional)\([^\n]*\)\s+(?<declaration>[^:\n]+):/gu
  )) {
    const { declaration, decorator } = match.groups ?? {}
    if (
      declaration === undefined ||
      !/\b(?:private|protected|public)\b/u.test(declaration) ||
      !/\breadonly\b/u.test(declaration)
    ) {
      violations.push(
        `${display(file)}: @${decorator ?? 'Inject'} parameters must be readonly constructor parameter properties`
      )
    }
  }
  if (
    /(?:\btype\s+[A-Za-z_$][\w$]*(?:<[^;=]+>)?\s*=|:\s*)\s*['"][^'"]+['"]\s*\|\s*['"][^'"]+['"]/u.test(
      content
    ) ||
    /^\s*\|\s*['"][^'"]+['"]/mu.test(content)
  ) {
    violations.push(
      `${display(file)}: finite string unions must be declared as string enums`
    )
  }
  if (
    content.includes("from '@wendellhu/redi'") &&
    /\bInjector\b/u.test(content) &&
    file !== resolve(repositoryRoot, 'apps/cli/src/bootstrap/container.ts') &&
    !file.endsWith('.test.ts')
  ) {
    violations.push(
      `${display(file)}: Injector may only be imported by the composition root`
    )
  }

  for (const specifier of imports) {
    if (file.startsWith(resolve(repositoryRoot, 'packages/core/src'))) {
      if (specifier === 'incur' || specifier.startsWith('incur/')) {
        violations.push(`${display(file)}: Core must not depend on Incur`)
      }
      if (specifier.includes('apps/cli')) {
        violations.push(`${display(file)}: Core must not depend on the CLI app`)
      }
    }
    if (!specifier.startsWith('.')) {
      continue
    }
    if (/\.[cm]?[jt]sx?$/u.test(specifier)) {
      violations.push(
        `${display(file)}: bundled TypeScript source imports must omit file extensions: ${specifier}`
      )
    }
    const target = resolveImport(file, specifier)
    if (target === null || !sourceSet.has(target)) {
      continue
    }
    resolvedImports.push(target)
    enforceDirection(file, target)
  }
  edges.set(file, resolvedImports)
}

for (const file of allSourceFiles.filter(isJavaScriptSource)) {
  violations.push(`${display(file)}: JavaScript source files are forbidden`)
}

detectCycles(edges)

if (violations.length > 0) {
  process.stderr.write(
    `Architecture check failed:\n${violations.map((item) => `- ${item}`).join('\n')}\n`
  )
  process.exitCode = 1
} else {
  process.stdout.write(
    `Architecture check passed (${sourceFiles.length} TypeScript source files).\n`
  )
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)))
    } else if (entry.isFile()) {
      files.push(path)
    }
  }
  return files
}

function isTypeScriptSource(file: string): boolean {
  return (
    ['.ts', '.tsx', '.mts', '.cts'].includes(extname(file)) &&
    !file.endsWith('.d.ts')
  )
}

function isJavaScriptSource(file: string): boolean {
  return ['.js', '.jsx', '.mjs', '.cjs'].includes(extname(file))
}

function isServiceImplementation(file: string): boolean {
  return (
    file.includes(`${sep}service${sep}`) &&
    /Service\.[cm]?tsx?$/u.test(file) &&
    !file.endsWith('.test.ts')
  )
}

function importedSpecifiers(content: string): readonly string[] {
  const values = new Set<string>()
  for (const match of content.matchAll(
    /\bfrom\s+['"](?<specifier>[^'"]+)['"]/gu
  )) {
    const specifier = match.groups?.specifier
    if (specifier !== undefined) {
      values.add(specifier)
    }
  }
  for (const match of content.matchAll(
    /\bimport\s*\(\s*['"](?<specifier>[^'"]+)['"]\s*\)/gu
  )) {
    const specifier = match.groups?.specifier
    if (specifier !== undefined) {
      values.add(specifier)
    }
  }
  for (const match of content.matchAll(
    /\bimport\s+['"](?<specifier>[^'"]+)['"]/gu
  )) {
    const specifier = match.groups?.specifier
    if (specifier !== undefined) {
      values.add(specifier)
    }
  }
  return [...values]
}

function resolveImport(importer: string, specifier: string): string | null {
  const candidate = resolve(dirname(importer), specifier)
  for (const extension of ['.ts', '.tsx', '.mts', '.cts']) {
    const source = `${candidate}${extension}`
    if (sourceSet.has(source)) {
      return source
    }
  }
  for (const index of ['index.ts', 'index.tsx', 'index.mts', 'index.cts']) {
    const source = resolve(candidate, index)
    if (sourceSet.has(source)) {
      return source
    }
  }
  return null
}

function enforceDirection(importer: string, target: string): void {
  const importerPath = display(importer)
  const targetPath = display(target)
  let packageRoot: string | null = null
  if (importerPath.startsWith('packages/core/')) {
    packageRoot = 'packages/core/src/'
  } else if (importerPath.startsWith('apps/cli/')) {
    packageRoot = 'apps/cli/src/'
  }
  if (packageRoot === null) {
    return
  }

  if (importerPath.startsWith(`${packageRoot}contract/`)) {
    for (const forbidden of ['service/', 'module/', 'bootstrap/']) {
      if (targetPath.startsWith(`${packageRoot}${forbidden}`)) {
        violations.push(`${importerPath}: contract cannot import ${targetPath}`)
      }
    }
  }
  if (
    packageRoot === 'packages/core/src/' &&
    importerPath.startsWith(`${packageRoot}service/`) &&
    targetPath.startsWith(`${packageRoot}module/`)
  ) {
    violations.push(
      `${importerPath}: root service cannot import business module ${targetPath}`
    )
  }
  if (
    importerPath.startsWith('packages/core/src/module/repoMirror/') &&
    (targetPath.startsWith('packages/core/src/module/task/') ||
      targetPath.startsWith('packages/core/src/module/uninstall/'))
  ) {
    violations.push(`${importerPath}: repoMirror cannot import ${targetPath}`)
  }
}

function detectCycles(graph: ReadonlyMap<string, readonly string[]>): void {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []

  const visit = (file: string): void => {
    if (visited.has(file)) {
      return
    }
    if (visiting.has(file)) {
      const start = stack.indexOf(file)
      const cycle = [...stack.slice(start), file].map(display).join(' -> ')
      violations.push(`source dependency cycle: ${cycle}`)
      return
    }
    visiting.add(file)
    stack.push(file)
    for (const target of graph.get(file) ?? []) {
      visit(target)
    }
    stack.pop()
    visiting.delete(file)
    visited.add(file)
  }

  for (const file of graph.keys()) {
    visit(file)
  }
}

function display(path: string): string {
  return relative(repositoryRoot, path).split(sep).join('/')
}
