import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type { AddTaskRepoMirrorsInput, AddTaskRepoMirrorsOutput } from '../types/index'

export interface IAddTaskRepoMirrorsService {
  execute(input: AddTaskRepoMirrorsInput): Promise<AddTaskRepoMirrorsOutput>
}

export const IAddTaskRepoMirrorsService: IdentifierDecorator<IAddTaskRepoMirrorsService> =
  createIdentifier<IAddTaskRepoMirrorsService>('core.addTaskRepoMirrorsService')
