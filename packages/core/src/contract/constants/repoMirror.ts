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
