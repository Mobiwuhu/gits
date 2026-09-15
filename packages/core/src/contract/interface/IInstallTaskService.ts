import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type { CommandOutput, InstallTaskInput } from '../types/index'

export interface IInstallTaskService {
  execute(input: InstallTaskInput): Promise<CommandOutput>
}

export const IInstallTaskService: IdentifierDecorator<IInstallTaskService> =
  createIdentifier<IInstallTaskService>('core.installTaskService')
