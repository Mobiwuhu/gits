import { randomUUID } from 'node:crypto'
import { readFile, rename } from 'node:fs/promises'
import { resolve } from 'node:path'

import { Inject } from '@wendellhu/redi'

import {
  IFileSystemService,
  IGitsPathService,
  ITaskTemplateLockService,
  ITaskTemplateSnapshotService,
  ITaskTemplateStoreService,
  TaskTemplateAction,
  TaskTemplateAlreadyExistsError,
  TaskTemplateCommandName,
  UnknownTaskTemplateError,
} from '../../../contract/index'
import type {
  IRenameTaskTemplateService,
  RenameTaskTemplateInput,
  TaskTemplateCommandOutput,
  TaskTemplateManifest,
} from '../../../contract/index'
import { throwIfAborted } from '../../../util/index'
import { assertTaskTemplateName } from './taskTemplateHelpers'
import { requireTemplateLock } from './taskTemplateOperationHelpers'

export class RenameTaskTemplateService implements IRenameTaskTemplateService {
  constructor(
    @Inject(IFileSystemService)
    private readonly fileSystem: IFileSystemService,
    @Inject(IGitsPathService) private readonly paths: IGitsPathService,
    @Inject(ITaskTemplateLockService)
    private readonly locks: ITaskTemplateLockService,
    @Inject(ITaskTemplateSnapshotService)
    private readonly snapshots: ITaskTemplateSnapshotService,
    @Inject(ITaskTemplateStoreService)
    private readonly store: ITaskTemplateStoreService
  ) {}

  async execute(
    input: RenameTaskTemplateInput
  ): Promise<TaskTemplateCommandOutput> {
    assertTaskTemplateName(input.name)
    assertTaskTemplateName(input.newName)
    if (input.name === input.newName) {
      throw new TaskTemplateAlreadyExistsError(input.newName)
    }
    const release = requireTemplateLock(
      await this.locks.acquireMany([input.name, input.newName]),
      [input.name, input.newName]
    )
    const source = this.store.path(input.name)
    const target = this.store.path(input.newName)
    const staging = resolve(
      this.paths.temporary,
      `.gits-template-rename-${input.name}-${process.pid}-${randomUUID()}`
    )
    let staged = false
    try {
      if (!(await this.store.exists(input.name))) {
        throw new UnknownTaskTemplateError(input.name)
      }
      if (await this.store.exists(input.newName)) {
        throw new TaskTemplateAlreadyExistsError(input.newName)
      }
      const template = await this.store.load(input.name)
      throwIfAborted(input.signal)
      await rename(source, staging)
      staged = true
      const manifestPath = resolve(staging, 'manifest.json')
      const original = await readFile(manifestPath, 'utf-8')
      const manifest: TaskTemplateManifest = {
        ...template.manifest,
        name: input.newName,
        updatedAt: new Date().toISOString(),
      }
      try {
        await this.fileSystem.writeFileAtomically(
          manifestPath,
          `${JSON.stringify(manifest, null, 2)}\n`
        )
        await this.snapshots.read(staging, input.newName)
        throwIfAborted(input.signal)
        await rename(staging, target)
        staged = false
      } catch (error) {
        await this.fileSystem.writeFileAtomically(manifestPath, original)
        await rename(staging, source)
        staged = false
        throw error
      }
      const renamed = await this.store.load(input.newName)
      return {
        command: TaskTemplateCommandName.Rename,
        ok: true,
        templates: [this.snapshots.toView(renamed, TaskTemplateAction.Renamed)],
      }
    } finally {
      if (staged) {
        try {
          await rename(staging, source)
        } catch {
          // Preserve staging for manual recovery when rollback itself fails.
        }
      }
      await release()
    }
  }
}
