export interface RepositoryLocation {
  readonly absolutePath: string
  readonly name: string
  readonly path: string
}

export interface TaskRepository extends RepositoryLocation {
  readonly branch: string
  readonly checkout: readonly string[] | null
  readonly dissociate: boolean
  readonly from: string
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
