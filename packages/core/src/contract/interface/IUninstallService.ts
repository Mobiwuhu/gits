import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type {
  GitsUninstallOutput,
  GitsUninstallPlan,
  UninstallGitsInput,
} from '../types/index'

export interface IUninstallService {
  execute(input: UninstallGitsInput): Promise<GitsUninstallOutput>
  plan(force?: boolean): Promise<GitsUninstallPlan>
}

export const IUninstallService: IdentifierDecorator<IUninstallService> =
  createIdentifier<IUninstallService>('core.uninstallService')
