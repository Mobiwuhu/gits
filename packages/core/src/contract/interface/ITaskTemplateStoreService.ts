import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type { StoredTaskTemplate, TaskTemplateCapture } from '../types/index'

export interface ITaskTemplateStoreService {
  candidatePath(name: string): Promise<string>
  exists(name: string): Promise<boolean>
  listNames(): Promise<readonly string[]>
  load(name: string): Promise<StoredTaskTemplate>
  path(name: string): string
  removeCandidate(path: string): Promise<void>
  writeCandidate(capture: TaskTemplateCapture): Promise<string>
}

export const ITaskTemplateStoreService: IdentifierDecorator<ITaskTemplateStoreService> =
  createIdentifier<ITaskTemplateStoreService>('core.taskTemplateStoreService')
