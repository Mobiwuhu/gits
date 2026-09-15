import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type { CommandOutput, PushTaskInput } from '../types/index'

export interface IPushTaskService {
  execute(input: PushTaskInput): Promise<CommandOutput>
}

export const IPushTaskService: IdentifierDecorator<IPushTaskService> =
  createIdentifier<IPushTaskService>('core.pushTaskService')
