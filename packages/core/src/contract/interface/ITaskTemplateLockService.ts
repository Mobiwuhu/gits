import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

export type TaskTemplateLockRelease = () => Promise<void>

export interface ITaskTemplateLockService {
  acquire(name: string): Promise<TaskTemplateLockRelease | null>
  acquireMany(names: readonly string[]): Promise<TaskTemplateLockRelease | null>
}

export const ITaskTemplateLockService: IdentifierDecorator<ITaskTemplateLockService> =
  createIdentifier<ITaskTemplateLockService>('core.taskTemplateLockService')
