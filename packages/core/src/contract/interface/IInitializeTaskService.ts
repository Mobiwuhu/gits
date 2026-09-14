import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type { CommandOutput, InitializeTaskInput } from '../types/index'

export interface IInitializeTaskService {
  execute(input: InitializeTaskInput): Promise<CommandOutput>
}

export const IInitializeTaskService: IdentifierDecorator<IInitializeTaskService> =
  createIdentifier<IInitializeTaskService>('core.initializeTaskService')
