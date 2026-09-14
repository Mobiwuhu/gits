import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type { CliInstance } from '../types/index'

export interface ICliCommand {
  register(cli: CliInstance): void
}

export const ICliCommand: IdentifierDecorator<ICliCommand> =
  createIdentifier<ICliCommand>('cli.command')
