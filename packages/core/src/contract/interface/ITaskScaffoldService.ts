import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

export interface ITaskScaffoldService {
  ensure(root: string): Promise<void>
}

export const ITaskScaffoldService: IdentifierDecorator<ITaskScaffoldService> =
  createIdentifier<ITaskScaffoldService>('core.taskScaffoldService')
