import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

export interface ITaskScaffoldService {
  ensure(root: string): Promise<void>
  isDefaultContent(
    root: string,
    relativePath: string,
    content: string
  ): Promise<boolean>
}

export const ITaskScaffoldService: IdentifierDecorator<ITaskScaffoldService> =
  createIdentifier<ITaskScaffoldService>('core.taskScaffoldService')
