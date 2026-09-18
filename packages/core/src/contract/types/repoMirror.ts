import type { GitCommandResult } from './git'

export enum RepoMirrorRepositoryState {
  Initializing = 'initializing',
  Ready = 'ready',
  Missing = 'missing',
  Invalid = 'invalid',
}

export enum RepoMirrorScheduleState {
  Off = 'off',
  Ready = 'ready',
  Unavailable = 'unavailable',
  Drifted = 'drifted',
}

export enum RepoMirrorLastRunStatus {
  Never = 'never',
  Running = 'running',
  Success = 'success',
  Failed = 'failed',
  Interrupted = 'interrupted',
  SkippedLocked = 'skipped-locked',
}

export enum RepoMirrorInvocationSource {
  Manual = 'manual',
  Scheduler = 'scheduler',
}

export enum RepoMirrorSchedulerBackend {
  Launchd = 'launchd',
  Systemd = 'systemd',
  Unsupported = 'unsupported',
}

export interface RepoMirrorSchedule {
  readonly cron: string
}

export interface RepoMirrorDefinition {
  readonly name: string
  readonly schedule?: RepoMirrorSchedule
  readonly urls: readonly [string, ...string[]]
}

export interface RepoMirrorSettings {
  readonly maxConcurrentFetches: number
}

export interface RepoMirrorConfiguration {
  readonly repoMirrors: readonly RepoMirrorDefinition[]
  readonly repoMirrorsSettings: RepoMirrorSettings
  readonly version: 1
}

export interface RepoMirrorCommandError {
  readonly code: string
  readonly message: string
}

export enum RepoMirrorAction {
  Created = 'created',
  Updated = 'updated',
  Unchanged = 'unchanged',
  Fetched = 'fetched',
  Removed = 'removed',
  Repaired = 'repaired',
  Checked = 'checked',
  Skipped = 'skipped',
  Failed = 'failed',
  NotRun = 'not-run',
}

export interface RepoMirrorRunState {
  readonly attemptedAt: string
  readonly durationMs: number
  readonly error?: string
  readonly finishedAt: string
  readonly source: RepoMirrorInvocationSource
  readonly status: RepoMirrorLastRunStatus
  readonly succeededAt?: string
}

export interface RepoMirrorView {
  readonly action: RepoMirrorAction
  readonly aliases: readonly string[]
  readonly dependents: readonly string[]
  readonly error: RepoMirrorCommandError | null
  readonly fetchCommand: string
  readonly fetchInvocation: Readonly<{
    readonly arguments: readonly string[]
    readonly environment: Readonly<Record<string, string>>
    readonly executable: string
  }>
  readonly fetchUrl: string
  readonly forced?: boolean
  readonly lastRun: RepoMirrorRunState | null
  readonly name: string
  readonly nativeJob: string | null
  readonly nextFetchAt: string | null
  readonly path: string
  readonly repositoryState: RepoMirrorRepositoryState
  readonly schedule: RepoMirrorSchedule | null
  readonly scheduleState: RepoMirrorScheduleState
  readonly schedulerBackend: RepoMirrorSchedulerBackend
  readonly schedulerMessage?: string
  readonly sizeBytes: number | null
  readonly projectionPath: string | null
  readonly urls: readonly string[]
}

export interface RepoMirrorCommandOutput {
  readonly command: string
  readonly mirrors: readonly RepoMirrorView[]
  readonly ok: boolean
  readonly warnings?: readonly string[]
}

export interface RepoMirrorHealth {
  readonly issues: readonly string[]
  readonly state: RepoMirrorRepositoryState
}

export interface RepoMirrorDependent {
  readonly gitDirectory: string
  readonly registeredAt: string
  readonly repositoryPath: string
}

export interface RepoMirrorDependencyState {
  readonly dependents: readonly RepoMirrorDependent[]
  readonly mirrorName: string
  readonly version: 1
}

export interface RepoMirrorDetachFailure {
  readonly message: string
  readonly repositoryPath: string
}

export interface RepoMirrorDetachResult {
  readonly detached: readonly string[]
  readonly failures: readonly RepoMirrorDetachFailure[]
}

export interface RepoMirrorLease {
  readonly name: string
  readonly path: string
  release(): Promise<void>
}

export interface RepoMirrorResolution {
  readonly fallbackReason?: string
  readonly lease: RepoMirrorLease | null
}

export interface RepoMirrorGitOperation {
  readonly commands: readonly GitCommandResult[]
  readonly ok: boolean
}

export type RepoMirrorLockRelease = () => Promise<void>

export interface RepoMirrorLogSession {
  readonly startedAt: string
  event(
    command: Readonly<{ durationMs: number; exitCode: number | null }>
  ): void
  finish(
    status: RepoMirrorLastRunStatus,
    options?: Readonly<{ error?: string }>
  ): Promise<RepoMirrorRunState>
}

export interface RepoMirrorScheduledInvocation {
  readonly arguments: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly executable: string
}

export interface RepoMirrorSchedulerObservation {
  readonly backend: RepoMirrorSchedulerBackend
  readonly message?: string
  readonly nativeJob: string | null
  readonly projectionPath: string | null
  readonly state: RepoMirrorScheduleState
}

export interface StableRunnerObservation {
  readonly message?: string
  readonly path: string
  readonly state:
    | RepoMirrorScheduleState.Ready
    | RepoMirrorScheduleState.Drifted
    | RepoMirrorScheduleState.Unavailable
  readonly workerPath: string
}
