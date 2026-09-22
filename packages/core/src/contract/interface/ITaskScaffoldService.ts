import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type { ScaffoldFile } from '../types/index'

export interface ITaskScaffoldService {
  ensure(root: string): Promise<void>
  isDefaultContent(
    root: string,
    relativePath: string,
    content: string
  ): Promise<boolean>
  render(root: string): Promise<readonly ScaffoldFile[]>
}

export const ITaskScaffoldService: IdentifierDecorator<ITaskScaffoldService> =
  createIdentifier<ITaskScaffoldService>('core.taskScaffoldService')
