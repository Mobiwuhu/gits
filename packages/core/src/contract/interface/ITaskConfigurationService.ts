import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type { RawTaskConfiguration } from '../types/index'

export interface ITaskConfigurationService {
  load(root: string): Promise<RawTaskConfiguration>
}

export const ITaskConfigurationService: IdentifierDecorator<ITaskConfigurationService> =
  createIdentifier<ITaskConfigurationService>('core.taskConfigurationService')
