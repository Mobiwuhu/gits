import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

export interface ITaskRootService {
  findTaskRoot(start: string): Promise<string>
  resolveWorkingDirectory(input: string | undefined): Promise<string>
}

export const ITaskRootService: IdentifierDecorator<ITaskRootService> =
  createIdentifier<ITaskRootService>('core.taskRootService')
