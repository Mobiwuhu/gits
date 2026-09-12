export type RepoMirrorRepositoryState = 'initializing' | 'ready' | 'missing' | 'invalid'

export type RepoMirrorScheduleState = 'off' | 'ready' | 'unavailable' | 'drifted'

export type RepoMirrorLastRunStatus =
  | 'never'
  | 'running'
  | 'success'
  | 'failed'
  | 'interrupted'
  | 'skipped-locked'

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

export type RepoMirrorAction =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'fetched'
  | 'removed'
  | 'repaired'
  | 'checked'
  | 'skipped'
  | 'failed'
  | 'not-run'

export interface RepoMirrorRunState {
  readonly attemptedAt: string
  readonly durationMs: number
  readonly error?: string
  readonly finishedAt: string
  readonly source: 'manual' | 'scheduler'
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
  readonly schedulerBackend: 'launchd' | 'systemd' | 'unsupported'
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
