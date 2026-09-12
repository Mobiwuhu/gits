import type { TaskConfiguration } from '../../domain/task/model.js'

export interface RawTaskConfiguration {
  readonly configuration: TaskConfiguration
  readonly content: string
}

export interface TaskConfigurationStore {
  createTemplate(root: string): Promise<void>
  load(root: string): Promise<RawTaskConfiguration>
}
