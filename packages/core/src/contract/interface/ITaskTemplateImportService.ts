import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type { TaskConfiguration } from '../types/index'

export interface ITaskTemplateImportService {
  importTemplate(sourceRoot: string, targetRoot: string): Promise<TaskConfiguration>
}

export const ITaskTemplateImportService: IdentifierDecorator<ITaskTemplateImportService> =
  createIdentifier<ITaskTemplateImportService>('core.taskTemplateImportService')
