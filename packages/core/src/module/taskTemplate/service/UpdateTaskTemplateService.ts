import { randomUUID } from 'node:crypto'
import { rename, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { Inject } from '@wendellhu/redi'

import corePackage from '../../../../package.json' with { type: 'json' }
import {
  IGitsPathService,
  ITaskTemplateLockService,
  ITaskTemplateSnapshotService,
  ITaskTemplateStoreService,
  TaskTemplateAction,
  TaskTemplateCommandName,
  taskTemplateSelectionPolicy,
  TaskTemplateState,
  UnknownTaskTemplateError,
} from '../../../contract/index'
import type {
  IUpdateTaskTemplateService,
  TaskTemplateCommandOutput,
  UpdateTaskTemplateInput,
} from '../../../contract/index'
import { errorMessage, throwIfAborted } from '../../../util/index'
import { assertTaskTemplateName } from './taskTemplateHelpers'
import {
  assertTemplateSourceSafety,
  captureView,
  requireTemplateLock,
} from './taskTemplateOperationHelpers'

export class UpdateTaskTemplateService implements IUpdateTaskTemplateService {
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
    input: UpdateTaskTemplateInput
  ): Promise<TaskTemplateCommandOutput> {
    assertTaskTemplateName(input.name)
    const sourceRoot = await assertTemplateSourceSafety(
      input.sourceRoot,
      this.paths
    )
    if (!(await this.store.exists(input.name))) {
      throw new UnknownTaskTemplateError(input.name)
    }
    const existing = await this.store.load(input.name)
    throwIfAborted(input.signal)
    const capture = await this.snapshots.capture({
      createdAt: existing.manifest.createdAt,
      createdWith: corePackage.version,
      name: input.name,
      sourceRoot,
    })
    const target = this.store.path(input.name)
    if (input.dryRun) {
      return {
        command: TaskTemplateCommandName.Update,
        ok: true,
        selection: {
          capturedEntryCount: capture.entries.length,
          policy: taskTemplateSelectionPolicy,
        },
        templates: [
          captureView(
            capture,
            TaskTemplateAction.Updated,
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
    const backup = resolve(
      this.paths.temporary,
      `.gits-template-backup-${input.name}-${process.pid}-${randomUUID()}`
    )
    let movedOld = false
    try {
      if (!(await this.store.exists(input.name))) {
        throw new UnknownTaskTemplateError(input.name)
      }
      candidate = await this.store.writeCandidate(capture)
      await this.snapshots.read(candidate, input.name)
      throwIfAborted(input.signal)
      await rename(target, backup)
      movedOld = true
      try {
        await rename(candidate, target)
        candidate = undefined
        movedOld = false
      } catch (error) {
        await rename(backup, target)
        movedOld = false
        throw error
      }
      let cleanupWarning: string | undefined
      try {
        await rm(backup, { force: true, recursive: true })
      } catch (error) {
        cleanupWarning = `Updated template successfully, but could not remove transaction backup ${backup}: ${errorMessage(error)}`
      }
      return {
        command: TaskTemplateCommandName.Update,
        ok: true,
        selection: {
          capturedEntryCount: capture.entries.length,
          policy: taskTemplateSelectionPolicy,
        },
        templates: [captureView(capture, TaskTemplateAction.Updated, target)],
        ...(cleanupWarning === undefined ? {} : { warnings: [cleanupWarning] }),
      }
    } finally {
      if (movedOld) {
        try {
          await rename(backup, target)
        } catch {
          // Keep the backup for manual recovery rather than deleting valid data.
        }
      }
      if (candidate !== undefined) {
        await this.store.removeCandidate(candidate)
      }
      await release()
    }
  }
}
