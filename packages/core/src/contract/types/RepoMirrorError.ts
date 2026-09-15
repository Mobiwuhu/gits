import { GitsError } from './GitsError'

export class RepoMirrorConfigurationError extends GitsError {
  readonly issues: readonly string[]

  constructor(message: string, issues: readonly string[] = []) {
    super(
      'repo-mirror-config-invalid',
      issues.length === 0 ? message : `${message} ${issues.join(' ')}`,
      2
    )
    this.name = 'RepoMirrorConfigurationError'
    this.issues = issues
  }
}

export class UnknownRepoMirrorError extends GitsError {
  readonly names: readonly string[]

  constructor(names: readonly string[]) {
    super('unknown-repo-mirror', `Unknown repo mirrors: ${names.join(', ')}`, 2)
    this.name = 'UnknownRepoMirrorError'
    this.names = names
  }
}

export class RepoMirrorUsageError extends GitsError {
  constructor(message: string) {
    super('repo-mirror-usage-error', message, 2)
    this.name = 'RepoMirrorUsageError'
  }
}

export class RepoMirrorBusyError extends GitsError {
  constructor(name: string) {
    super(
      'repo-mirror-busy',
      `Repo mirror '${name}' is being used by another process.`,
      1
    )
    this.name = 'RepoMirrorBusyError'
  }
}
