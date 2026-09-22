import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type { CliInstance } from '../types/index'

export interface ITaskTemplateSubcommand {
  register(cli: CliInstance): void
}

export const ITaskTemplateSubcommand: IdentifierDecorator<ITaskTemplateSubcommand> =
  createIdentifier<ITaskTemplateSubcommand>('cli.taskTemplateSubcommand')
