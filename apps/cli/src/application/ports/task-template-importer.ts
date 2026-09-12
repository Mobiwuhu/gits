import type { TaskConfiguration } from '../../domain/task/model.js'

/** Imports the portable task metadata from one task directory into another. */
export interface TaskTemplateImporter {
  importTemplate(sourceRoot: string, targetRoot: string): Promise<TaskConfiguration>
}
