import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type {
  AddTaskTemplateInput,
  TaskTemplateCommandOutput,
} from '../types/index'

export interface IAddTaskTemplateService {
  execute(input: AddTaskTemplateInput): Promise<TaskTemplateCommandOutput>
}

export const IAddTaskTemplateService: IdentifierDecorator<IAddTaskTemplateService> =
  createIdentifier<IAddTaskTemplateService>('core.addTaskTemplateService')
