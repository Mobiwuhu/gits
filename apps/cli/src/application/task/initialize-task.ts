import { access } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { GitRepositoryGateway } from '../ports/git-repository-gateway.js'
import type { TaskConfigurationStore } from '../ports/task-configuration-store.js'
import type { TaskScaffold } from '../ports/task-scaffold.js'
import type { TaskTemplateImporter } from '../ports/task-template-importer.js'
import { loadTaskConfiguration } from './load-task-configuration.js'
import {
  initialRepositoryResult,
  type CommandOutput,
  type RepositoryCommandResult,
  type TaskConfiguration,
} from '../../domain/task/model.js'

export interface InitializeTaskInput {
  readonly root: string
  readonly scanPath?: string
  readonly signal?: AbortSignal
}

export interface InitializeTaskDependencies {
  readonly configurationStore: TaskConfigurationStore
  readonly git: GitRepositoryGateway
  readonly scaffold: TaskScaffold
  readonly templateImporter: TaskTemplateImporter
}

export async function initializeTask(
  dependencies: InitializeTaskDependencies,
  input: InitializeTaskInput,
): Promise<CommandOutput> {
  if (input.scanPath === undefined) {
    await initializeEmptyTask(dependencies, input)
    return { command: 'init', ok: true, repos: [] }
  }

  const sourceRoot = resolve(input.root, input.scanPath)
  await loadTaskConfiguration(dependencies.configurationStore, dependencies.git, {
    allowIncomplete: true,
    root: sourceRoot,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const configuration = await dependencies.templateImporter.importTemplate(sourceRoot, input.root)
  await dependencies.scaffold.ensure(input.root)

  return {
    command: 'init',
    ok: true,
    repos: importedRepositories(configuration),
  }
}

async function initializeEmptyTask(
  dependencies: InitializeTaskDependencies,
  input: InitializeTaskInput,
): Promise<void> {
  if (await hasConfiguration(input.root)) {
    await loadTaskConfiguration(dependencies.configurationStore, dependencies.git, {
      allowIncomplete: true,
      root: input.root,
      ...(input.signal ? { signal: input.signal } : {}),
    })
  } else {
    await dependencies.configurationStore.createTemplate(input.root)
  }

  await dependencies.scaffold.ensure(input.root)
}

function importedRepositories(
  configuration: TaskConfiguration,
): readonly RepositoryCommandResult[] {
  return configuration.repositories.map((repository) => ({
    ...initialRepositoryResult(repository),
    result: 'success',
  }))
}

async function hasConfiguration(root: string): Promise<boolean> {
  try {
    await access(resolve(root, 'task.config.jsonc'))
    return true
  } catch {
    return false
  }
}
