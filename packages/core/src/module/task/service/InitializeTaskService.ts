import { access } from 'node:fs/promises'
import { resolve } from 'node:path'

import { Inject } from '@wendellhu/redi'

import {
  IGitService,
  RepositoryActionResult,
  ITaskConfigurationService,
  ITaskScaffoldService,
  ITaskTemplateImportService,
  initialRepositoryResult,
} from '../../../contract/index'
import type {
  IInitializeTaskService,
  InitializeTaskInput,
  CommandOutput,
  RepositoryCommandResult,
  TaskConfiguration,
} from '../../../contract/index'
import { loadTaskConfiguration } from './loadTaskConfiguration'

export class InitializeTaskService implements IInitializeTaskService {
  constructor(
    @Inject(ITaskConfigurationService)
    private readonly configurationStore: ITaskConfigurationService,
    @Inject(IGitService) private readonly git: IGitService,
    @Inject(ITaskScaffoldService)
    private readonly scaffold: ITaskScaffoldService,
    @Inject(ITaskTemplateImportService)
    private readonly templateImporter: ITaskTemplateImportService
  ) {}

  async execute(input: InitializeTaskInput): Promise<CommandOutput> {
    if (input.scanPath === undefined) {
      await this.initializeEmptyTask(input)
      return { command: 'init', ok: true, repos: [] }
    }

    const sourceRoot = resolve(input.root, input.scanPath)
    await loadTaskConfiguration(this.configurationStore, this.git, {
      allowIncomplete: true,
      root: sourceRoot,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    const configuration = await this.templateImporter.importTemplate(
      sourceRoot,
      input.root
    )
    await this.scaffold.ensure(input.root)

    return {
      command: 'init',
      ok: true,
      repos: this.importedRepositories(configuration),
    }
  }

  private async initializeEmptyTask(input: InitializeTaskInput): Promise<void> {
    if (await this.hasConfiguration(input.root)) {
      await loadTaskConfiguration(this.configurationStore, this.git, {
        allowIncomplete: true,
        root: input.root,
        ...(input.signal ? { signal: input.signal } : {}),
      })
    }

    await this.scaffold.ensure(input.root)
  }

  private importedRepositories(
    configuration: TaskConfiguration
  ): readonly RepositoryCommandResult[] {
    return configuration.repositories.map((repository) => ({
      ...initialRepositoryResult(repository),
      result: RepositoryActionResult.Success,
    }))
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
