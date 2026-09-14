import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type { CommandOutput, SwitchTaskInput } from '../types/index'

export interface ISwitchTaskService {
  execute(input: SwitchTaskInput): Promise<CommandOutput>
}

export const ISwitchTaskService: IdentifierDecorator<ISwitchTaskService> =
  createIdentifier<ISwitchTaskService>('core.switchTaskService')
