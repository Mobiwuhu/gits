import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type { CliInstance } from '../types/index'

export interface IRepoMirrorSubcommand {
  register(cli: CliInstance): void
}

export const IRepoMirrorSubcommand: IdentifierDecorator<IRepoMirrorSubcommand> =
  createIdentifier<IRepoMirrorSubcommand>('cli.repoMirrorSubcommand')
