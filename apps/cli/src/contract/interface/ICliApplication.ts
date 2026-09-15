import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

export interface ICliApplication {
  run(argv: readonly string[]): Promise<void>
}

export const ICliApplication: IdentifierDecorator<ICliApplication> =
  createIdentifier<ICliApplication>('cli.application')
