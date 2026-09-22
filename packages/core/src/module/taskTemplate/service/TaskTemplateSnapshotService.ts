import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { Inject } from '@wendellhu/redi'
import * as v from 'valibot'

import corePackage from '../../../../package.json' with { type: 'json' }
import {
  builtInTaskTemplateName,
  GitsError,
  ITaskDirectorySourcePlanService,
  ITaskScaffoldService,
  taskTemplateManifestSchema,
  TaskDirectoryEntryKind,
  TaskDirectorySourcePolicy,
  TaskTemplateAction,
  TaskTemplateKind,
  taskTemplateSelectionPolicy,
  TaskTemplateState,
} from '../../../contract/index'
import type {
  CaptureTaskTemplateOptions,
  ITaskTemplateSnapshotService,
  ScaffoldFile,
  StoredTaskTemplate,
  TaskDirectoryEntry,
  TaskTemplateCapture,
  TaskTemplateManifest,
  TaskTemplateView,
} from '../../../contract/index'
import {
  errorMessage,
  hasErrorCode,
  normalizeRelativePath,
} from '../../../util/index'
import { parseTaskConfiguration } from '../../task/service/TaskConfigurationService'
import { assertTaskTemplateName } from './taskTemplateHelpers'

interface RequiredEntry {
  readonly kind: TaskDirectoryEntryKind.Directory | TaskDirectoryEntryKind.File
  readonly relativePath: string
}

export class TaskTemplateSnapshotService implements ITaskTemplateSnapshotService {
  constructor(
    @Inject(ITaskDirectorySourcePlanService)
    private readonly sourcePlans: ITaskDirectorySourcePlanService,
    @Inject(ITaskScaffoldService)
    private readonly scaffold: ITaskScaffoldService
  ) {}

  async capture(
    options: CaptureTaskTemplateOptions
  ): Promise<TaskTemplateCapture> {
    assertTaskTemplateName(options.name)
    const scaffoldFiles = await this.scaffold.render(options.sourceRoot)
    const required = requiredEntries(scaffoldFiles)
    const plan = await this.sourcePlans.plan(
      options.sourceRoot,
      TaskDirectorySourcePolicy.NamedTemplate,
      {
        allowedRepositoryPaths: required
          .map((entry) => entry.relativePath)
          .filter((path) => path === 'repos' || path.startsWith('repos/')),
      }
    )
    await this.assertCompleteScaffold(
      options.sourceRoot,
      plan.entries,
      required
    )
    await this.validateConfiguration(options.sourceRoot, plan.entries)
    const now = new Date().toISOString()
    const content = await contentSummary(plan.entries)
    const manifest: TaskTemplateManifest = {
      schemaVersion: 1,
      name: options.name,
      createdAt: options.createdAt ?? now,
      updatedAt: now,
      createdWith: options.createdWith,
      scaffold: {
        digest: scaffoldDigest(required),
        requiredEntryCount: required.length,
      },
      selection: { policy: taskTemplateSelectionPolicy },
      content,
    }
    return { entries: plan.entries, manifest }
  }

  async write(capture: TaskTemplateCapture, root: string): Promise<void> {
    const contentRoot = resolve(root, 'content')
    await mkdir(contentRoot, { mode: 0o700, recursive: true })
    for (const entry of capture.entries) {
      const target = resolve(contentRoot, entry.relativePath)
      if (entry.kind === TaskDirectoryEntryKind.Directory) {
        await mkdir(target, { mode: entry.mode & 0o777, recursive: true })
        await chmod(target, entry.mode & 0o777)
        continue
      }
      await mkdir(dirname(target), { mode: 0o700, recursive: true })
      if (entry.kind === TaskDirectoryEntryKind.Symlink) {
        if (entry.linkTarget === undefined) {
          throw new GitsError(
            'template-entry-invalid',
            `Symbolic link target is missing for ${entry.relativePath}.`
          )
        }
        await symlink(entry.linkTarget, target)
        continue
      }
      await copyFile(entry.sourcePath, target)
      await chmod(target, entry.mode & 0o777)
    }
    await writeFile(
      resolve(root, 'manifest.json'),
      `${JSON.stringify(capture.manifest, null, 2)}\n`,
      { encoding: 'utf-8', flag: 'wx', mode: 0o600 }
    )
  }

  async read(root: string, expectedName: string): Promise<StoredTaskTemplate> {
    await assertStoredPath(root, TaskDirectoryEntryKind.Directory, expectedName)
    const manifestPath = resolve(root, 'manifest.json')
    await assertStoredPath(
      manifestPath,
      TaskDirectoryEntryKind.File,
      expectedName
    )
    const manifest = await readManifest(manifestPath)
    if (manifest.name !== expectedName) {
      throw new GitsError(
        'template-integrity-failed',
        `Template directory '${expectedName}' contains manifest for '${manifest.name}'.`
      )
    }
    const contentRoot = resolve(root, 'content')
    await assertStoredPath(
      contentRoot,
      TaskDirectoryEntryKind.Directory,
      expectedName
    )
    const scaffoldFiles = await this.scaffold.render(contentRoot)
    const required = requiredEntries(scaffoldFiles)
    const plan = await this.sourcePlans.plan(
      contentRoot,
      TaskDirectorySourcePolicy.StoredTemplate
    )
    this.assertStoredSafety(plan.entries, required, expectedName)
    await this.assertCompleteScaffold(contentRoot, plan.entries, required, true)
    if (
      manifest.scaffold.digest !== scaffoldDigest(required) ||
      manifest.scaffold.requiredEntryCount !== required.length
    ) {
      throw new GitsError(
        'template-integrity-failed',
        `Template '${expectedName}' was created for a different task scaffold contract.`
      )
    }
    await this.validateConfiguration(contentRoot, plan.entries)
    const actual = await contentSummary(plan.entries)
    if (
      actual.digest !== manifest.content.digest ||
      actual.fileCount !== manifest.content.fileCount ||
      actual.byteCount !== manifest.content.byteCount
    ) {
      throw new GitsError(
        'template-integrity-failed',
        `Template '${expectedName}' content does not match its manifest.`
      )
    }
    return { contentRoot, manifest, root }
  }

  toView(
    template: StoredTaskTemplate,
    action: TaskTemplateAction,
    path: string | null = template.root
  ): TaskTemplateView {
    return {
      action,
      byteCount: template.manifest.content.byteCount,
      createdAt: template.manifest.createdAt,
      createdWith: template.manifest.createdWith,
      digest: template.manifest.content.digest,
      error: null,
      fileCount: template.manifest.content.fileCount,
      kind: TaskTemplateKind.Local,
      name: template.manifest.name,
      path,
      state:
        action === TaskTemplateAction.Removed
          ? TaskTemplateState.Removed
          : TaskTemplateState.Ready,
      updatedAt: template.manifest.updatedAt,
    }
  }

  async builtInView(
    action: TaskTemplateAction = TaskTemplateAction.Listed
  ): Promise<TaskTemplateView> {
    const files = await this.scaffold.render(process.cwd())
    const hash = createHash('sha256')
    let byteCount = 0
    for (const file of files.toSorted((left, right) =>
      left.relativePath.localeCompare(right.relativePath)
    )) {
      hash.update(`file\0${file.relativePath}\0`)
      hash.update(file.content)
      byteCount += Buffer.byteLength(file.content)
    }
    return {
      action,
      byteCount,
      createdAt: null,
      createdWith: corePackage.version,
      digest: `sha256:${hash.digest('hex')}`,
      error: null,
      fileCount: files.length,
      kind: TaskTemplateKind.BuiltIn,
      name: builtInTaskTemplateName,
      path: null,
      state: TaskTemplateState.Ready,
      updatedAt: null,
    }
  }

  private async assertCompleteScaffold(
    root: string,
    entries: readonly TaskDirectoryEntry[],
    required: readonly RequiredEntry[],
    stored = false
  ): Promise<void> {
    const selected = new Map(
      entries.map((entry) => [entry.relativePath, entry])
    )
    const missing: string[] = []
    const ignored: string[] = []
    const invalid: string[] = []

    for (const requirement of required) {
      const entry = selected.get(requirement.relativePath)
      if (entry !== undefined) {
        if (entry.kind !== requirement.kind) {
          invalid.push(
            `${requirement.relativePath} (expected ${requirement.kind}, found ${entry.kind})`
          )
        }
        continue
      }
      try {
        await lstat(resolve(root, requirement.relativePath))
        ignored.push(requirement.relativePath)
      } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
          missing.push(requirement.relativePath)
          continue
        }
        throw error
      }
    }

    if (missing.length === 0 && ignored.length === 0 && invalid.length === 0) {
      return
    }
    const details = [
      ...section('Missing', missing),
      ...section(stored ? 'Unavailable' : 'Ignored by .gitignore', ignored),
      ...section('Invalid', invalid),
    ]
    const code = stored
      ? 'template-integrity-failed'
      : invalid.length > 0
        ? 'template-scaffold-invalid'
        : ignored.length > 0
          ? 'template-scaffold-ignored'
          : 'template-scaffold-incomplete'
    const guidance =
      !stored && ignored.length > 0
        ? ' Update the applicable .gitignore or add a matching ! negation rule.'
        : ''
    throw new GitsError(
      code,
      `Source directory is not a complete gits task scaffold. ${details.join(' ')}${guidance}`
    )
  }

  private async validateConfiguration(
    root: string,
    entries: readonly TaskDirectoryEntry[]
  ): Promise<void> {
    const entry = entries.find(
      (candidate) => candidate.relativePath === 'task.config.jsonc'
    )
    if (entry?.kind !== TaskDirectoryEntryKind.File) {
      throw new GitsError(
        'template-content-invalid',
        'Template task.config.jsonc must be a regular file.'
      )
    }
    const content = await readFile(entry.sourcePath, 'utf-8')
    try {
      parseTaskConfiguration(root, entry.sourcePath, content)
    } catch (error) {
      const message = errorMessage(error)
      throw new GitsError(
        'template-content-invalid',
        `Template task.config.jsonc is invalid: ${message}`
      )
    }
  }

  private assertStoredSafety(
    entries: readonly TaskDirectoryEntry[],
    required: readonly RequiredEntry[],
    name: string
  ): void {
    const allowedRepositoryPaths = new Set(
      required
        .map((entry) => entry.relativePath)
        .filter((path) => path === 'repos' || path.startsWith('repos/'))
    )
    const forbidden = entries
      .map((entry) => entry.relativePath)
      .filter(
        (path) =>
          /^\.gits-(?:import|template)-/u.test(path) ||
          ((path === 'repos' || path.startsWith('repos/')) &&
            !allowedRepositoryPaths.has(path))
      )
    if (forbidden.length > 0) {
      throw new GitsError(
        'template-integrity-failed',
        `Template '${name}' contains forbidden snapshot content: ${forbidden.join(', ')}.`
      )
    }
  }
}

function requiredEntries(
  files: readonly ScaffoldFile[]
): readonly RequiredEntry[] {
  const requirements = new Map<string, RequiredEntry['kind']>()
  for (const file of files) {
    requirements.set(file.relativePath, TaskDirectoryEntryKind.File)
    let parent = normalizeRelativePath(dirname(file.relativePath))
    while (parent !== '.' && parent.length > 0) {
      if (!requirements.has(parent)) {
        requirements.set(parent, TaskDirectoryEntryKind.Directory)
      }
      parent = normalizeRelativePath(dirname(parent))
    }
  }
  return [...requirements]
    .map(([relativePath, kind]) => ({ kind, relativePath }))
    .toSorted((left, right) =>
      left.relativePath.localeCompare(right.relativePath)
    )
}

function scaffoldDigest(required: readonly RequiredEntry[]): string {
  const hash = createHash('sha256')
  for (const entry of required) {
    hash.update(`${entry.kind}\0${entry.relativePath}\n`)
  }
  return `sha256:${hash.digest('hex')}`
}

async function contentSummary(
  entries: readonly TaskDirectoryEntry[]
): Promise<TaskTemplateManifest['content']> {
  const hash = createHash('sha256')
  let byteCount = 0
  let fileCount = 0
  for (const entry of entries.toSorted((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  )) {
    hash.update(`${entry.kind}\0${entry.relativePath}\0${entry.mode & 0o111}\0`)
    if (entry.kind === TaskDirectoryEntryKind.File) {
      const content = await readFile(entry.sourcePath)
      hash.update(content)
      byteCount += content.byteLength
      fileCount += 1
    } else if (entry.kind === TaskDirectoryEntryKind.Symlink) {
      const target = entry.linkTarget ?? ''
      hash.update(target)
      byteCount += Buffer.byteLength(target)
      fileCount += 1
    }
    hash.update('\0')
  }
  return {
    byteCount,
    digest: `sha256:${hash.digest('hex')}`,
    fileCount,
    hashAlgorithm: 'sha256',
  }
}

async function readManifest(path: string): Promise<TaskTemplateManifest> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf-8'))
  } catch (error) {
    const message = errorMessage(error)
    throw new GitsError(
      'template-integrity-failed',
      `Cannot read task template manifest ${path}: ${message}`
    )
  }
  const result = v.safeParse(taskTemplateManifestSchema, value)
  if (!result.success) {
    throw invalidManifest(path, v.summarize(result.issues))
  }
  assertTaskTemplateName(result.output.name)
  return result.output
}

function invalidManifest(path: string, issue: string): GitsError {
  return new GitsError(
    'template-integrity-failed',
    `Task template manifest ${path} is invalid: ${issue}.`
  )
}

async function assertStoredPath(
  path: string,
  kind: TaskDirectoryEntryKind.Directory | TaskDirectoryEntryKind.File,
  name: string
): Promise<void> {
  try {
    const metadata = await lstat(path)
    const matches =
      !metadata.isSymbolicLink() &&
      (kind === TaskDirectoryEntryKind.Directory
        ? metadata.isDirectory()
        : metadata.isFile())
    if (matches) {
      return
    }
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      const message = errorMessage(error)
      throw new GitsError(
        'template-integrity-failed',
        `Cannot inspect template '${name}' path ${path}: ${message}`
      )
    }
  }
  throw new GitsError(
    'template-integrity-failed',
    `Template '${name}' requires ${path} to be a real ${kind}.`
  )
}

function section(label: string, values: readonly string[]): readonly string[] {
  return values.length === 0 ? [] : [`${label}: ${values.join(', ')}.`]
}
