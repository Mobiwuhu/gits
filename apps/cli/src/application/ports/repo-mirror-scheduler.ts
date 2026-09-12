import type {
  RepoMirrorDefinition,
  RepoMirrorScheduleState,
} from '../../domain/repo-mirror/model.js'

export interface RepoMirrorScheduledInvocation {
  readonly arguments: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly executable: string
}

export interface RepoMirrorSchedulerObservation {
  readonly backend: 'launchd' | 'systemd' | 'unsupported'
  readonly message?: string
  readonly nativeJob: string | null
  readonly projectionPath: string | null
  readonly state: RepoMirrorScheduleState
}

export interface RepoMirrorScheduler {
  apply(definition: RepoMirrorDefinition): Promise<RepoMirrorSchedulerObservation>
  inspect(definition: RepoMirrorDefinition): Promise<RepoMirrorSchedulerObservation>
  invocation(name: string): RepoMirrorScheduledInvocation
  remove(name: string): Promise<RepoMirrorSchedulerObservation>
}
