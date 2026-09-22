import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type {
  ListTaskTemplatesInput,
  TaskTemplateCommandOutput,
} from '../types/index'

export interface IListTaskTemplateService {
  execute(input: ListTaskTemplatesInput): Promise<TaskTemplateCommandOutput>
}

export const IListTaskTemplateService: IdentifierDecorator<IListTaskTemplateService> =
  createIdentifier<IListTaskTemplateService>('core.listTaskTemplateService')
