import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type {
  TaskTemplateCommandOutput,
  UpdateTaskTemplateInput,
} from '../types/index'

export interface IUpdateTaskTemplateService {
  execute(input: UpdateTaskTemplateInput): Promise<TaskTemplateCommandOutput>
}

export const IUpdateTaskTemplateService: IdentifierDecorator<IUpdateTaskTemplateService> =
  createIdentifier<IUpdateTaskTemplateService>('core.updateTaskTemplateService')
