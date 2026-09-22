export enum RepositoryState {
  Missing = 'missing',
  NotGit = 'not-git',
  WrongRepo = 'wrong-repo',
  Detached = 'detached',
  WrongBranch = 'wrong-branch',
  UpstreamGone = 'upstream-gone',
  WrongUpstream = 'wrong-upstream',
  LocalOnly = 'local-only',
  Diverged = 'diverged',
  Ahead = 'ahead',
  Behind = 'behind',
  SyncedLocal = 'synced-local',
}

export const repositoryStates: readonly RepositoryState[] =
  Object.values(RepositoryState)

export enum RepositoryFlag {
  CheckoutDifferent = 'checkout-different',
  Dirty = 'dirty',
  UrlDifferent = 'url-different',
}

export const repositoryFlags: readonly RepositoryFlag[] =
  Object.values(RepositoryFlag)

export enum RepositoryActionResult {
  Success = 'success',
  Skipped = 'skipped',
  Failed = 'failed',
  NotRun = 'not-run',
}
