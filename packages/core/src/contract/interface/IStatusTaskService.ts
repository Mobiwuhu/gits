import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type { CommandOutput, StatusTaskInput } from '../types/index'

export interface IStatusTaskService {
  execute(input: StatusTaskInput): Promise<CommandOutput>
}

export const IStatusTaskService: IdentifierDecorator<IStatusTaskService> =
  createIdentifier<IStatusTaskService>('core.statusTaskService')
