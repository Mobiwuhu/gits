import { UnknownRepositoryError } from '../../../contract/index'
import type { TaskConfiguration, TaskRepository } from '../../../contract/index'

export function selectRepositories(
  configuration: TaskConfiguration,
  names: readonly string[]
): readonly TaskRepository[] {
  if (names.length === 0) {
    return configuration.repositories
  }

  const byName = new Map(
    configuration.repositories.map((repository) => [
      repository.name,
      repository,
    ])
  )
  const unknown = names.filter((name) => !byName.has(name))

  if (unknown.length > 0) {
    throw new UnknownRepositoryError(unknown)
  }

  const requested = new Set(names)
  return configuration.repositories.filter((repository) =>
    requested.has(repository.name)
  )
}
