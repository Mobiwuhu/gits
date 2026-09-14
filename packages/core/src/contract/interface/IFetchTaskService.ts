import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type { CommandOutput, FetchTaskInput } from '../types/index'

export interface IFetchTaskService {
  execute(input: FetchTaskInput): Promise<CommandOutput>
}

export const IFetchTaskService: IdentifierDecorator<IFetchTaskService> =
  createIdentifier<IFetchTaskService>('core.fetchTaskService')
