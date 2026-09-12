export class GitsError extends Error {
  readonly code: string
  readonly exitCode: number

  constructor(code: string, message: string, exitCode = 2) {
    super(message)
    this.name = 'GitsError'
    this.code = code
    this.exitCode = exitCode
  }
}

export class ConfigurationError extends GitsError {
  readonly issues: readonly string[]

  constructor(message: string, issues: readonly string[] = []) {
    super('config-invalid', issues.length > 0 ? `${message} ${issues.join(' ')}` : message, 2)
    this.name = 'ConfigurationError'
    this.issues = issues
  }
}

export class IncompleteConfigurationError extends GitsError {
  readonly repositories: readonly TaskRepository[]

  constructor(repositories: readonly TaskRepository[]) {
    super(
      'config-incomplete',
      `Configuration contains placeholder values for: ${repositories
        .map((repository) => repository.name)
        .join(', ')}`,
      2,
    )
    this.name = 'IncompleteConfigurationError'
    this.repositories = repositories
  }
}

export class UnknownRepositoryError extends GitsError {
  readonly names: readonly string[]

  constructor(names: readonly string[]) {
    super('unknown-repository', `Unknown repositories: ${names.join(', ')}`, 2)
    this.name = 'UnknownRepositoryError'
    this.names = names
  }
}

export class UsageError extends GitsError {
  constructor(message: string) {
    super('usage-error', message, 2)
    this.name = 'UsageError'
  }
}

export class UninstallSafetyError extends GitsError {
  constructor(message: string) {
    super('uninstall-safety', message, 2)
    this.name = 'UninstallSafetyError'
  }
}
import type { TaskRepository } from './model.js'
