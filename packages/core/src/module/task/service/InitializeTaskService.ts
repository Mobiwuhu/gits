import { access } from 'node:fs/promises'
import { posix, resolve } from 'node:path'

import { Inject } from '@wendellhu/redi'

import {
  builtInTaskTemplateName,
  GitsError,
  IGitService,
  IGitsPathService,
  InitializeTaskTemplateKind,
  ITaskConfigurationService,
  ITaskDirectoryMaterializationService,
  ITaskDirectorySourcePlanService,
  ITaskScaffoldService,
  ITaskTemplateStoreService,
  RepositoryActionResult,
  TaskDirectoryEntryKind,
  TaskDirectorySourcePolicy,
  TaskTemplateUsageError,
  UnknownTaskTemplateError,
} from '../../../contract/index'
import type {
  IInitializeTaskService,
  InitializeTaskInput,
  InitializeTaskOutput,
  MaterializationEntry,
  RepositoryCommandResult,
  ScaffoldFile,
  TaskConfiguration,
  TaskDirectoryEntry,
} from '../../../contract/index'
import { initialRepositoryResult } from '../../../service/repositoryResult'
import { canonicalizePath, isPathInside } from '../../../util/index'
import {
  assertSeparatePaths,
  toMaterializationEntry,
} from '../../taskTemplate/service/taskTemplateHelpers'
import { loadTaskConfiguration } from './loadTaskConfiguration'

export class InitializeTaskService implements IInitializeTaskService {
  constructor(
    @Inject(ITaskConfigurationService)
    private readonly configurationStore: ITaskConfigurationService,
    @Inject(IGitService) private readonly git: IGitService,
    @Inject(IGitsPathService) private readonly paths: IGitsPathService,
    @Inject(ITaskDirectoryMaterializationService)
    private readonly materialization: ITaskDirectoryMaterializationService,
    @Inject(ITaskDirectorySourcePlanService)
    private readonly sourcePlans: ITaskDirectorySourcePlanService,
    @Inject(ITaskScaffoldService)
    private readonly scaffold: ITaskScaffoldService,
    @Inject(ITaskTemplateStoreService)
    private readonly templates: ITaskTemplateStoreService
  ) {}

  async execute(input: InitializeTaskInput): Promise<InitializeTaskOutput> {
    if (input.fromPath !== undefined && input.template !== undefined) {
      throw new TaskTemplateUsageError(
        '--from and --template cannot be combined.'
      )
    }
    const target = await canonicalizePath(input.root)
    await this.assertSafeTarget(target)

    if (input.fromPath !== undefined) {
      return this.initializeFromDirectory(input, target)
    }
    const templateName = input.template ?? builtInTaskTemplateName
    if (templateName === builtInTaskTemplateName) {
      return this.initializeBuiltIn(input, target)
    }
    return this.initializeStoredTemplate(input, target, templateName)
  }

  private async initializeBuiltIn(
    input: InitializeTaskInput,
    target: string
  ): Promise<InitializeTaskOutput> {
    if (await this.hasConfiguration(target)) {
      await loadTaskConfiguration(this.configurationStore, this.git, {
        allowIncomplete: true,
        root: target,
        ...(input.signal ? { signal: input.signal } : {}),
      })
    }
    if (!input.dryRun) {
      await this.scaffold.ensure(target)
    }
    return {
      command: 'init',
      ok: true,
      repos: [],
      template: {
        kind: InitializeTaskTemplateKind.BuiltIn,
        name: builtInTaskTemplateName,
        source: null,
        target,
      },
    }
  }

  private async initializeStoredTemplate(
    input: InitializeTaskInput,
    target: string,
    name: string
  ): Promise<InitializeTaskOutput> {
    if (!(await this.templates.exists(name))) {
      throw new UnknownTaskTemplateError(name)
    }
    const template = await this.templates.load(name)
    const plan = await this.sourcePlans.plan(
      template.contentRoot,
      TaskDirectorySourcePolicy.StoredTemplate
    )
    const configuration = await loadTaskConfiguration(
      this.configurationStore,
      this.git,
      {
        allowIncomplete: true,
        root: template.contentRoot,
        ...(input.signal ? { signal: input.signal } : {}),
      }
    )
    await this.materialization.materialize({
      dryRun: input.dryRun,
      entries: plan.entries.map(toMaterializationEntry),
      root: target,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    return {
      command: 'init',
      ok: true,
      repos: this.importedRepositories(configuration, target),
      template: {
        kind: InitializeTaskTemplateKind.Local,
        name,
        source: template.root,
        target,
      },
    }
  }

  private async initializeFromDirectory(
    input: InitializeTaskInput,
    target: string
  ): Promise<InitializeTaskOutput> {
    const source = await canonicalizePath(input.fromPath ?? '')
    assertSeparatePaths(
      source,
      target,
      '--from source directory must not equal, contain, or be contained by the target task directory.'
    )
    const home = await canonicalizePath(this.paths.home)
    if (isPathInside(home, source) || isPathInside(source, home)) {
      throw new GitsError(
        'template-source-overlap',
        `--from source must not overlap GITS_HOME: ${source}`
      )
    }
    const plan = await this.sourcePlans.plan(
      source,
      TaskDirectorySourcePolicy.OneOffImport
    )
    const configurationEntry = plan.entries.find(
      (entry) => entry.relativePath === 'task.config.jsonc'
    )
    if (configurationEntry?.kind !== TaskDirectoryEntryKind.File) {
      throw new GitsError(
        'template-source-config-unavailable',
        'The --from source must contain an effective, regular task.config.jsonc that is not excluded by .gitignore.'
      )
    }
    const configuration = await loadTaskConfiguration(
      this.configurationStore,
      this.git,
      {
        allowIncomplete: true,
        root: source,
        ...(input.signal ? { signal: input.signal } : {}),
      }
    )
    const scaffoldFiles = await this.scaffold.render(target)
    const entries = mergeWithScaffold(plan.entries, scaffoldFiles)
    await this.materialization.materialize({
      dryRun: input.dryRun,
      entries,
      root: target,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    return {
      command: 'init',
      ok: true,
      repos: this.importedRepositories(configuration, target),
      template: {
        kind: InitializeTaskTemplateKind.Directory,
        name: null,
        source,
        target,
      },
    }
  }

  private importedRepositories(
    configuration: TaskConfiguration,
    targetRoot: string
  ): readonly RepositoryCommandResult[] {
    return configuration.repositories.map((repository) => ({
      ...initialRepositoryResult({
        ...repository,
        absolutePath: resolve(targetRoot, repository.path),
      }),
      result: RepositoryActionResult.Success,
    }))
  }

  private async assertSafeTarget(target: string): Promise<void> {
    const home = await canonicalizePath(this.paths.home)
    if (isPathInside(home, target) || isPathInside(target, home)) {
      throw new GitsError(
        'template-source-overlap',
        `Task target must not overlap GITS_HOME: ${target}`
      )
    }
  }

  private async hasConfiguration(root: string): Promise<boolean> {
    try {
      await access(resolve(root, 'task.config.jsonc'))
      return true
    } catch {
      return false
    }
  }
}

function mergeWithScaffold(
  sourceEntries: readonly TaskDirectoryEntry[],
  scaffoldFiles: readonly ScaffoldFile[]
): readonly MaterializationEntry[] {
  const entries = new Map<string, MaterializationEntry>(
    sourceEntries.map((entry) => [
      entry.relativePath,
      toMaterializationEntry(entry),
    ])
  )
  for (const file of scaffoldFiles) {
    const existing = entries.get(file.relativePath)
    if (existing !== undefined) {
      if (existing.kind !== TaskDirectoryEntryKind.File) {
        throw new GitsError(
          'template-scaffold-invalid',
          `Source ${file.relativePath} must be a regular file to match the task scaffold.`
        )
      }
      continue
    }
    addParentDirectories(entries, file.relativePath)
    entries.set(file.relativePath, {
      content: file.content,
      kind: TaskDirectoryEntryKind.File,
      mode: 0o644,
      relativePath: file.relativePath,
    })
  }
  return [...entries.values()]
}

function addParentDirectories(
  entries: Map<string, MaterializationEntry>,
  relativePath: string
): void {
  let parent = posix.dirname(relativePath)
  const missing: string[] = []
  while (parent !== '.' && parent.length > 0) {
    const existing = entries.get(parent)
    if (existing !== undefined) {
      if (existing.kind !== TaskDirectoryEntryKind.Directory) {
        throw new GitsError(
          'template-scaffold-invalid',
          `Source ${parent} must be a directory to match the task scaffold.`
        )
      }
      break
    }
    missing.push(parent)
    parent = posix.dirname(parent)
  }
  for (const path of missing.toReversed()) {
    entries.set(path, {
      kind: TaskDirectoryEntryKind.Directory,
      mode: 0o755,
      relativePath: path,
    })
  }
}
