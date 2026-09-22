import { Inject } from '@wendellhu/redi'

import {
  ITaskTemplateSnapshotService,
  ITaskTemplateStoreService,
  TaskTemplateAction,
  TaskTemplateCommandName,
  TaskTemplateKind,
  TaskTemplateState,
} from '../../../contract/index'
import type {
  IListTaskTemplateService,
  ListTaskTemplatesInput,
  TaskTemplateCommandOutput,
  TaskTemplateView,
} from '../../../contract/index'
import { errorCommand } from './taskTemplateHelpers'

export class ListTaskTemplateService implements IListTaskTemplateService {
  constructor(
    @Inject(ITaskTemplateSnapshotService)
    private readonly snapshots: ITaskTemplateSnapshotService,
    @Inject(ITaskTemplateStoreService)
    private readonly store: ITaskTemplateStoreService
  ) {}

  async execute(
    _input: ListTaskTemplatesInput
  ): Promise<TaskTemplateCommandOutput> {
    const names = await this.store.listNames()
    const templates = await Promise.all(
      names.map(async (name): Promise<TaskTemplateView> => {
        try {
          const template = await this.store.load(name)
          return this.snapshots.toView(template, TaskTemplateAction.Listed)
        } catch (error) {
          return {
            action: TaskTemplateAction.Listed,
            byteCount: null,
            createdAt: null,
            createdWith: 'unknown',
            digest: null,
            error: errorCommand(error),
            fileCount: null,
            kind: TaskTemplateKind.Local,
            name,
            path: this.safePath(name),
            state: TaskTemplateState.Unhealthy,
            updatedAt: null,
          }
        }
      })
    )
    return {
      command: TaskTemplateCommandName.List,
      ok: true,
      templates: [await this.snapshots.builtInView(), ...templates],
    }
  }

  private safePath(name: string): string | null {
    try {
      return this.store.path(name)
    } catch {
      return null
    }
  }
}
