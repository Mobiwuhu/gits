import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type { MaterializeTaskDirectoryInput } from '../types/index'

export interface ITaskDirectoryMaterializationService {
  materialize(input: MaterializeTaskDirectoryInput): Promise<void>
}

export const ITaskDirectoryMaterializationService: IdentifierDecorator<ITaskDirectoryMaterializationService> =
  createIdentifier<ITaskDirectoryMaterializationService>(
    'core.taskDirectoryMaterializationService'
  )
