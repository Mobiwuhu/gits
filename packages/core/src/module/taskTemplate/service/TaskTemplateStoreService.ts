import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { Inject } from '@wendellhu/redi'

import {
  IGitsPathService,
  ITaskTemplateSnapshotService,
} from '../../../contract/index'
import type {
  ITaskTemplateStoreService,
  StoredTaskTemplate,
  TaskTemplateCapture,
} from '../../../contract/index'
import { hasErrorCode, pathEntryExists } from '../../../util/index'
import { assertTaskTemplateName } from './taskTemplateHelpers'

export class TaskTemplateStoreService implements ITaskTemplateStoreService {
  constructor(
    @Inject(IGitsPathService) private readonly paths: IGitsPathService,
    @Inject(ITaskTemplateSnapshotService)
    private readonly snapshots: ITaskTemplateSnapshotService
  ) {}

  path(name: string): string {
    assertTaskTemplateName(name)
    return resolve(this.paths.templates, name)
  }

  async exists(name: string): Promise<boolean> {
    return pathEntryExists(this.path(name))
  }

  async listNames(): Promise<readonly string[]> {
    let entries: Dirent[]
    try {
      entries = await readdir(this.paths.templates, { withFileTypes: true })
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return []
      }
      throw error
    }
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith('.'))
      .toSorted((left, right) => left.localeCompare(right))
  }

  async load(name: string): Promise<StoredTaskTemplate> {
    return this.snapshots.read(this.path(name), name)
  }

  async candidatePath(name: string): Promise<string> {
    assertTaskTemplateName(name)
    await this.paths.ensureLayout()
    return resolve(
      this.paths.temporary,
      `.gits-template-${name}-${process.pid}-${randomUUID()}`
    )
  }

  async writeCandidate(capture: TaskTemplateCapture): Promise<string> {
    const candidate = await this.candidatePath(capture.manifest.name)
    try {
      await this.snapshots.write(capture, candidate)
      return candidate
    } catch (error) {
      await this.removeCandidate(candidate)
      throw error
    }
  }

  async removeCandidate(path: string): Promise<void> {
    await rm(path, { force: true, recursive: true })
  }
}
