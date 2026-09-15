import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type { CliContext } from '../types/index'

export interface ICliConfirmationService {
  confirm(
    context: CliContext,
    alreadyConfirmed: boolean,
    message: string
  ): Promise<boolean>
}

export const ICliConfirmationService: IdentifierDecorator<ICliConfirmationService> =
  createIdentifier<ICliConfirmationService>('cli.confirmationService')
