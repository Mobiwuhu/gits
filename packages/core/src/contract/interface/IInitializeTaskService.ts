import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type { InitializeTaskInput, InitializeTaskOutput } from '../types/index'

export interface IInitializeTaskService {
  execute(input: InitializeTaskInput): Promise<InitializeTaskOutput>
}

export const IInitializeTaskService: IdentifierDecorator<IInitializeTaskService> =
  createIdentifier<IInitializeTaskService>('core.initializeTaskService')
