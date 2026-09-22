export enum GitOutputStream {
  Stderr = 'stderr',
  Stdout = 'stdout',
}

export enum GitBranchPreparationKind {
  CreatedFrom = 'created-from',
  ExistingLocal = 'existing-local',
  Failed = 'failed',
  TrackedRemote = 'tracked-remote',
}

export enum GitStdioMode {
  Inherit = 'inherit',
  InteractivePipe = 'interactive-pipe',
  Pipe = 'pipe',
}
