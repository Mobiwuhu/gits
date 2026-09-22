import {
  GitsPersistenceTargetKind,
  GitsPersistenceTargetScope,
  InitializeTaskTemplateKind,
  RepoMirrorAction,
  RepoMirrorInvocationSource,
  RepoMirrorLastRunStatus,
  RepoMirrorRepositoryState,
  RepoMirrorSchedulerBackend,
  RepoMirrorScheduleState,
  RepositoryActionResult,
  RepositoryFlag,
  RepositoryState,
  taskTemplateSelectionPolicy,
  TaskTemplateAction,
  TaskTemplateCommandName,
  TaskTemplateKind,
  TaskTemplateState,
} from '@usegits/core'
import type {
  CommandOutput,
  GitsUninstallOutput,
  InitializeTaskOutput,
  RepoMirrorCommandOutput,
  TaskTemplateCommandOutput,
} from '@usegits/core'
import { z } from 'incur'

export type CliCommandOutput<T> = T | string

type CliSchemaOutput<T> = T extends readonly (infer TItem)[]
  ? readonly CliSchemaOutput<TItem>[]
  : T extends object
    ? CliSchemaObject<T>
    : T

type CliSchemaObject<T extends object> = Readonly<
  {
    [TKey in Exclude<keyof T, OptionalKey<T>>]: CliSchemaOutput<T[TKey]>
  } & {
    [TKey in OptionalKey<T>]?: CliSchemaOutput<T[TKey]> | undefined
  }
>

type OptionalKey<T extends object> = {
  [TKey in keyof T]-?: {} extends Pick<T, TKey> ? TKey : never
}[keyof T]

export type CliValueOutput<T> =
  | Readonly<{
      command: string
      ok: true
      value: T
    }>
  | Readonly<{
      command: string
      error: Readonly<{
        code: string
        message: string
      }>
      ok: false
    }>

const commandErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
})

const repositoryCommandResultSchema = z.object({
  actual: z.object({
    ahead: z.number().nullable(),
    behind: z.number().nullable(),
    branch: z.string().nullable(),
    checkout: z.array(z.string()).nullable(),
    upstream: z.string().nullable(),
    url: z.string().nullable(),
  }),
  error: commandErrorSchema.nullable(),
  expected: z.object({
    branch: z.string(),
    checkout: z.array(z.string()).nullable(),
    upstream: z.string(),
    url: z.string(),
  }),
  flags: z.array(z.enum(RepositoryFlag)),
  name: z.string(),
  mirror: z
    .object({
      dissociated: z.boolean(),
      name: z.string(),
      path: z.string(),
    })
    .optional(),
  mirrorFallbackReason: z.string().optional(),
  path: z.string(),
  result: z.enum(RepositoryActionResult),
  state: z.enum(RepositoryState).nullable(),
})

const commandDataSchema = z.object({
  command: z.string(),
  ok: z.boolean(),
  repos: z.array(repositoryCommandResultSchema),
})

const initializeTaskDataSchema = commandDataSchema.extend({
  template: z.object({
    kind: z.enum(InitializeTaskTemplateKind),
    name: z.string().nullable(),
    source: z.string().nullable(),
    target: z.string(),
  }),
})

const repoMirrorLastRunSchema = z.object({
  attemptedAt: z.string(),
  durationMs: z.number(),
  error: z.string().optional(),
  finishedAt: z.string(),
  source: z.enum(RepoMirrorInvocationSource),
  status: z.enum(RepoMirrorLastRunStatus),
  succeededAt: z.string().optional(),
})

const repoMirrorViewSchema = z.object({
  action: z.enum(RepoMirrorAction),
  aliases: z.array(z.string()),
  dependents: z.array(z.string()),
  error: commandErrorSchema.nullable(),
  fetchCommand: z.string(),
  fetchInvocation: z.object({
    arguments: z.array(z.string()),
    environment: z.record(z.string(), z.string()),
    executable: z.string(),
  }),
  fetchUrl: z.string(),
  forced: z.boolean().optional(),
  lastRun: repoMirrorLastRunSchema.nullable(),
  name: z.string(),
  nativeJob: z.string().nullable(),
  nextFetchAt: z.string().nullable(),
  path: z.string(),
  projectionPath: z.string().nullable(),
  repositoryState: z.enum(RepoMirrorRepositoryState),
  schedule: z.object({ cron: z.string() }).nullable(),
  schedulerBackend: z.enum(RepoMirrorSchedulerBackend),
  schedulerMessage: z.string().optional(),
  scheduleState: z.enum(RepoMirrorScheduleState),
  sizeBytes: z.number().nullable(),
  urls: z.array(z.string()),
})

const repoMirrorDataSchema = z.object({
  command: z.string(),
  mirrors: z.array(repoMirrorViewSchema),
  ok: z.boolean(),
  warnings: z.array(z.string()).optional(),
})

const taskTemplateViewSchema = z.object({
  action: z.enum(TaskTemplateAction),
  byteCount: z.number().nullable(),
  createdAt: z.string().nullable(),
  createdWith: z.string(),
  digest: z.string().nullable(),
  error: commandErrorSchema.nullable(),
  fileCount: z.number().nullable(),
  kind: z.enum(TaskTemplateKind),
  name: z.string(),
  path: z.string().nullable(),
  state: z.enum(TaskTemplateState),
  updatedAt: z.string().nullable(),
})

const taskTemplateDataSchema = z.object({
  command: z.enum(TaskTemplateCommandName),
  ok: z.boolean(),
  selection: z
    .object({
      capturedEntryCount: z.number(),
      policy: z.literal(taskTemplateSelectionPolicy),
    })
    .optional(),
  templates: z.array(taskTemplateViewSchema),
  warnings: z.array(z.string()).optional(),
})

const uninstallDataSchema = z.object({
  command: z.literal('uninstall'),
  dryRun: z.boolean(),
  mirrors: z.array(
    z.object({
      dependents: z.array(z.string()),
      name: z.string(),
      path: z.string(),
    })
  ),
  ok: z.boolean(),
  removedMirrors: z.array(z.string()),
  removedPaths: z.array(z.string()),
  targets: z.array(
    z.object({
      description: z.string(),
      exists: z.boolean(),
      id: z.string(),
      kind: z.enum(GitsPersistenceTargetKind),
      path: z.string(),
      scope: z.enum(GitsPersistenceTargetScope),
    })
  ),
  warnings: z.array(z.string()),
})

export const commandOutputSchema: z.ZodType<
  CliCommandOutput<CliSchemaOutput<CommandOutput>>
> = renderedOutputSchema(commandDataSchema)

export const initializeTaskOutputSchema: z.ZodType<
  CliCommandOutput<
    CliSchemaOutput<CommandOutput> | CliSchemaOutput<InitializeTaskOutput>
  >
> = renderedOutputSchema(z.union([initializeTaskDataSchema, commandDataSchema]))

export const repoMirrorCommandOutputSchema: z.ZodType<
  CliCommandOutput<CliSchemaOutput<RepoMirrorCommandOutput>>
> = renderedOutputSchema(repoMirrorDataSchema)

export const taskTemplateCommandOutputSchema: z.ZodType<
  CliCommandOutput<CliSchemaOutput<TaskTemplateCommandOutput>>
> = renderedOutputSchema(taskTemplateDataSchema)

export const uninstallOutputSchema: z.ZodType<
  CliCommandOutput<CliSchemaOutput<GitsUninstallOutput>>
> = renderedOutputSchema(uninstallDataSchema)

export const repoMirrorPathOutputSchema: z.ZodType<
  CliCommandOutput<CliValueOutput<string>>
> = renderedOutputSchema(cliValueOutputSchema(z.string()))

export const repoMirrorLogsOutputSchema: z.ZodType<
  CliCommandOutput<CliValueOutput<readonly string[]>>
> = renderedOutputSchema(cliValueOutputSchema(z.array(z.string()).readonly()))

function renderedOutputSchema<T>(
  schema: z.ZodType<T>
): z.ZodType<CliCommandOutput<T>> {
  return z.union([schema, z.string()])
}

function cliValueOutputSchema<T>(
  value: z.ZodType<T>
): z.ZodType<CliValueOutput<T>> {
  return z.discriminatedUnion('ok', [
    z.object({ command: z.string(), ok: z.literal(true), value }),
    z.object({
      command: z.string(),
      error: commandErrorSchema,
      ok: z.literal(false),
    }),
  ])
}
