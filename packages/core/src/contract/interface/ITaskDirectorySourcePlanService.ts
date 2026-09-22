import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type { TaskDirectorySourcePolicy } from '../constants/index'
import type { TaskDirectorySourcePlan } from '../types/index'

export interface ITaskDirectorySourcePlanService {
  plan(
    sourceRoot: string,
    policy: TaskDirectorySourcePolicy,
    options?: Readonly<{ allowedRepositoryPaths?: readonly string[] }>
  ): Promise<TaskDirectorySourcePlan>
}

export const ITaskDirectorySourcePlanService: IdentifierDecorator<ITaskDirectorySourcePlanService> =
  createIdentifier<ITaskDirectorySourcePlanService>(
    'core.taskDirectorySourcePlanService'
  )
