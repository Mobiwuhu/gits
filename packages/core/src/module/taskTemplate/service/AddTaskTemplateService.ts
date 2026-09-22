import { rename } from 'node:fs/promises'

import { Inject } from '@wendellhu/redi'

import corePackage from '../../../../package.json' with { type: 'json' }
import {
  IGitsPathService,
  ITaskTemplateLockService,
  ITaskTemplateSnapshotService,
  ITaskTemplateStoreService,
  TaskTemplateAction,
  TaskTemplateAlreadyExistsError,
  TaskTemplateCommandName,
  taskTemplateSelectionPolicy,
  TaskTemplateState,
} from '../../../contract/index'
import type {
  AddTaskTemplateInput,
  IAddTaskTemplateService,
  TaskTemplateCommandOutput,
} from '../../../contract/index'
import { throwIfAborted } from '../../../util/index'
import { assertTaskTemplateName } from './taskTemplateHelpers'
import {
  assertTemplateSourceSafety,
  captureView,
  requireTemplateLock,
} from './taskTemplateOperationHelpers'

export class AddTaskTemplateService implements IAddTaskTemplateService {
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
    input: AddTaskTemplateInput
  ): Promise<TaskTemplateCommandOutput> {
    assertTaskTemplateName(input.name)
    const sourceRoot = await assertTemplateSourceSafety(
      input.sourceRoot,
      this.paths
    )
    if (await this.store.exists(input.name)) {
      throw new TaskTemplateAlreadyExistsError(input.name)
    }
    throwIfAborted(input.signal)
    const capture = await this.snapshots.capture({
      createdWith: corePackage.version,
      name: input.name,
      sourceRoot,
    })
    const target = this.store.path(input.name)
    if (input.dryRun) {
      return {
        command: TaskTemplateCommandName.Add,
        ok: true,
        selection: {
          capturedEntryCount: capture.entries.length,
          policy: taskTemplateSelectionPolicy,
        },
        templates: [
          captureView(
            capture,
            TaskTemplateAction.Added,
            target,
            TaskTemplateState.Planned
          ),
        ],
      }
    }

    const release = requireTemplateLock(await this.locks.acquire(input.name), [
      input.name,
    ])
    let candidate: string | undefined
    try {
      if (await this.store.exists(input.name)) {
        throw new TaskTemplateAlreadyExistsError(input.name)
      }
      throwIfAborted(input.signal)
      candidate = await this.store.writeCandidate(capture)
      await this.snapshots.read(candidate, input.name)
      throwIfAborted(input.signal)
      await rename(candidate, target)
      candidate = undefined
      return {
        command: TaskTemplateCommandName.Add,
        ok: true,
        selection: {
          capturedEntryCount: capture.entries.length,
          policy: taskTemplateSelectionPolicy,
        },
        templates: [captureView(capture, TaskTemplateAction.Added, target)],
      }
    } finally {
      if (candidate !== undefined) {
        await this.store.removeCandidate(candidate)
      }
      await release()
    }
  }
}
