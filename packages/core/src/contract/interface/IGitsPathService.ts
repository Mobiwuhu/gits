import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type { GitsPaths } from '../types/index'

export interface IGitsPathService extends GitsPaths {
  ensureLayout(): Promise<void>
  readOrCreateInstallationId(): Promise<string>
}

export const IGitsPathService: IdentifierDecorator<IGitsPathService> =
  createIdentifier<IGitsPathService>('core.gitsPathService')
