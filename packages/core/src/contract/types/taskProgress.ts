export interface RepositoryProgress {
  readonly phase: string
  readonly repository: string
}

export type RepositoryProgressReporter = (progress: RepositoryProgress) => void
