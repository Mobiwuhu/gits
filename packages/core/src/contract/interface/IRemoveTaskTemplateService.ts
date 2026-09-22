import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type {
  RemoveTaskTemplateInput,
  TaskTemplateCommandOutput,
} from '../types/index'

export interface IRemoveTaskTemplateService {
  execute(input: RemoveTaskTemplateInput): Promise<TaskTemplateCommandOutput>
}

export const IRemoveTaskTemplateService: IdentifierDecorator<IRemoveTaskTemplateService> =
  createIdentifier<IRemoveTaskTemplateService>('core.removeTaskTemplateService')
