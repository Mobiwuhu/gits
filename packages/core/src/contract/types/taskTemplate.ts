import * as v from 'valibot'

import { taskTemplateSelectionPolicy } from '../constants/taskTemplate'
import type {
  InitializeTaskTemplateKind,
  TaskDirectoryEntryKind,
  TaskDirectorySourcePolicy,
  TaskTemplateAction,
  TaskTemplateCommandName,
  TaskTemplateKind,
  TaskTemplateState,
} from '../constants/taskTemplate'
import type { CommandError, CommandOutput } from './commandResult'
import { isoDateSchema } from './schema'

const digestSchema = v.pipe(
  v.string(),
  v.regex(/^sha256:[0-9a-f]{64}$/u, 'Expected a SHA-256 digest')
)
const nonNegativeIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(0))
type TaskTemplateManifestShape = Readonly<{
  schemaVersion: 1
  name: string
  createdAt: string
  updatedAt: string
  createdWith: string
  scaffold: Readonly<{
    digest: string
    requiredEntryCount: number
  }>
  selection: Readonly<{
    policy: typeof taskTemplateSelectionPolicy
  }>
  content: Readonly<{
    hashAlgorithm: 'sha256'
    digest: string
    fileCount: number
    byteCount: number
  }>
}>

export const taskTemplateManifestSchema: v.GenericSchema<TaskTemplateManifestShape> =
  v.object({
    schemaVersion: v.literal(1),
    name: v.string(),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
    createdWith: v.string(),
    scaffold: v.object({
      digest: digestSchema,
      requiredEntryCount: nonNegativeIntegerSchema,
    }),
    selection: v.object({
      policy: v.literal(taskTemplateSelectionPolicy),
    }),
    content: v.object({
      hashAlgorithm: v.literal('sha256'),
      digest: digestSchema,
      fileCount: nonNegativeIntegerSchema,
      byteCount: nonNegativeIntegerSchema,
    }),
  })

export type TaskTemplateManifest = v.InferOutput<
  typeof taskTemplateManifestSchema
>

export interface TaskTemplateView {
  readonly action: TaskTemplateAction
  readonly byteCount: number | null
  readonly createdAt: string | null
  readonly createdWith: string
  readonly digest: string | null
  readonly error: CommandError | null
  readonly fileCount: number | null
  readonly kind: TaskTemplateKind
  readonly name: string
  readonly path: string | null
  readonly state: TaskTemplateState
  readonly updatedAt: string | null
}

export interface TaskTemplateCommandOutput {
  readonly command: TaskTemplateCommandName
  readonly ok: boolean
  readonly selection?: {
    readonly capturedEntryCount: number
    readonly policy: typeof taskTemplateSelectionPolicy
  }
  readonly templates: readonly TaskTemplateView[]
  readonly warnings?: readonly string[]
}

export interface AddTaskTemplateInput {
  readonly dryRun: boolean
  readonly name: string
  readonly signal?: AbortSignal
  readonly sourceRoot: string
}

export interface ListTaskTemplatesInput {
  readonly wide: boolean
}

export interface UpdateTaskTemplateInput extends AddTaskTemplateInput {}

export interface RenameTaskTemplateInput {
  readonly name: string
  readonly newName: string
  readonly signal?: AbortSignal
}

export interface RemoveTaskTemplateInput {
  readonly confirmed: boolean
  readonly name: string
  readonly purge: boolean
  readonly signal?: AbortSignal
}

export interface TaskDirectoryEntry {
  readonly kind: TaskDirectoryEntryKind
  readonly linkTarget?: string
  readonly mode: number
  readonly relativePath: string
  readonly size: number
  readonly sourcePath: string
}

export interface TaskDirectorySourcePlan {
  readonly entries: readonly TaskDirectoryEntry[]
  readonly policy: TaskDirectorySourcePolicy
  readonly sourceRoot: string
}

export interface ScaffoldFile {
  readonly content: string
  readonly path: string
  readonly relativePath: string
}

export interface TaskTemplateCapture {
  readonly entries: readonly TaskDirectoryEntry[]
  readonly manifest: TaskTemplateManifest
}

export interface StoredTaskTemplate {
  readonly contentRoot: string
  readonly manifest: TaskTemplateManifest
  readonly root: string
}

export interface MaterializationEntry {
  readonly content?: string
  readonly kind: TaskDirectoryEntryKind
  readonly linkTarget?: string
  readonly mode: number
  readonly relativePath: string
  readonly sourcePath?: string
}

export interface MaterializeTaskDirectoryInput {
  readonly dryRun: boolean
  readonly entries: readonly MaterializationEntry[]
  readonly root: string
  readonly signal?: AbortSignal
}

export interface InitializeTaskTemplateSource {
  readonly kind: InitializeTaskTemplateKind
  readonly name: string | null
  readonly source: string | null
  readonly target: string
}

export interface InitializeTaskOutput extends CommandOutput {
  readonly template: InitializeTaskTemplateSource
}
