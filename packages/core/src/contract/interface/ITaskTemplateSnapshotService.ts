import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type { TaskTemplateAction } from '../constants/index'
import type {
  StoredTaskTemplate,
  TaskTemplateCapture,
  TaskTemplateView,
} from '../types/index'

export interface CaptureTaskTemplateOptions {
  readonly createdAt?: string
  readonly createdWith: string
  readonly name: string
  readonly sourceRoot: string
}

export interface ITaskTemplateSnapshotService {
  builtInView(action?: TaskTemplateAction): Promise<TaskTemplateView>
  capture(options: CaptureTaskTemplateOptions): Promise<TaskTemplateCapture>
  read(root: string, expectedName: string): Promise<StoredTaskTemplate>
  toView(
    template: StoredTaskTemplate,
    action: TaskTemplateAction,
    path?: string | null
  ): TaskTemplateView
  write(capture: TaskTemplateCapture, root: string): Promise<void>
}

export const ITaskTemplateSnapshotService: IdentifierDecorator<ITaskTemplateSnapshotService> =
  createIdentifier<ITaskTemplateSnapshotService>(
    'core.taskTemplateSnapshotService'
  )
