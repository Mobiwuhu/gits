export interface TaskRepository {
  readonly absolutePath: string
  readonly branch: string
  readonly checkout: readonly string[] | null
  readonly dissociate: boolean
  readonly from: string
  readonly name: string
  readonly path: string
  readonly url: string
}

export interface TaskConfiguration {
  readonly configPath: string
  readonly repositories: readonly TaskRepository[]
  readonly root: string
}

export interface RawTaskConfiguration {
  readonly configuration: TaskConfiguration
  readonly content: string
}

export function isRepositoryIncomplete(repository: TaskRepository): boolean {
  return [
    repository.url,
    repository.branch,
    repository.from,
    repository.path,
    ...(repository.checkout ?? []),
  ].some((value) => /<[^>]+>/u.test(value))
}
