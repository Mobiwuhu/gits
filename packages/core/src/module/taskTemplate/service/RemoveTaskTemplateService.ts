import { mkdir, rename, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { Inject } from '@wendellhu/redi'

import {
  IGitsPathService,
  ITaskTemplateLockService,
  ITaskTemplateSnapshotService,
  ITaskTemplateStoreService,
  TaskTemplateAction,
  TaskTemplateCommandName,
  TaskTemplateKind,
  TaskTemplateState,
  TaskTemplateUsageError,
  UnknownTaskTemplateError,
} from '../../../contract/index'
import type {
  IRemoveTaskTemplateService,
  RemoveTaskTemplateInput,
  StoredTaskTemplate,
  TaskTemplateCommandOutput,
  TaskTemplateView,
} from '../../../contract/index'
import { throwIfAborted } from '../../../util/index'
import { assertTaskTemplateName, errorCommand } from './taskTemplateHelpers'
import { requireTemplateLock } from './taskTemplateOperationHelpers'

export class RemoveTaskTemplateService implements IRemoveTaskTemplateService {
  constructor(
    @Inject(IGitsPathService) private readonly paths: IGitsPathService,
    @Inject(ITaskTemplateLockService)
    private readonly locks: ITaskTemplateLockService,
    @Inject(ITaskTemplateSnapshotService)
    private readonly snapshots: ITaskTemplateSnapshotService,
    @Inject(ITaskTemplateStoreService)
    private readonly store: ITaskTemplateStoreService
  ) {}

  async execute(
    input: RemoveTaskTemplateInput
  ): Promise<TaskTemplateCommandOutput> {
    assertTaskTemplateName(input.name)
    if (!input.confirmed) {
      throw new TaskTemplateUsageError(
        'Template removal requires confirmation or --yes.'
      )
    }
    const release = requireTemplateLock(await this.locks.acquire(input.name), [
      input.name,
    ])
    try {
      if (!(await this.store.exists(input.name))) {
        throw new UnknownTaskTemplateError(input.name)
      }
      let template: StoredTaskTemplate | undefined
      let loadError: unknown
      try {
        template = await this.store.load(input.name)
      } catch (error) {
        loadError = error
      }
      throwIfAborted(input.signal)
      const source = this.store.path(input.name)
      let destination: string | null = null
      if (input.purge) {
        await rm(source, { force: true, recursive: true })
      } else {
        const trash = resolve(this.paths.trash, 'templates')
        await mkdir(trash, { mode: 0o700, recursive: true })
        const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, '')
        destination = resolve(trash, `${timestamp}-${input.name}`)
        await rename(source, destination)
      }
      const view =
        template === undefined
          ? unhealthyRemovedView(input.name, destination, loadError)
          : this.snapshots.toView(
              template,
              TaskTemplateAction.Removed,
              destination
            )
      return {
        command: TaskTemplateCommandName.Remove,
        ok: true,
        templates: [view],
      }
    } finally {
      await release()
    }
  }
}

function unhealthyRemovedView(
  name: string,
  path: string | null,
  error: unknown
): TaskTemplateView {
  return {
    action: TaskTemplateAction.Removed,
    byteCount: null,
    createdAt: null,
    createdWith: 'unknown',
    digest: null,
    error: errorCommand(error),
    fileCount: null,
    kind: TaskTemplateKind.Local,
    name,
    path,
    state: TaskTemplateState.Removed,
    updatedAt: null,
  }
}
