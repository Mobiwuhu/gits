import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type {
  RenameTaskTemplateInput,
  TaskTemplateCommandOutput,
} from '../types/index'

export interface IRenameTaskTemplateService {
  execute(input: RenameTaskTemplateInput): Promise<TaskTemplateCommandOutput>
}

export const IRenameTaskTemplateService: IdentifierDecorator<IRenameTaskTemplateService> =
  createIdentifier<IRenameTaskTemplateService>('core.renameTaskTemplateService')
