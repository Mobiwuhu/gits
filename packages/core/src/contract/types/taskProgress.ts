export interface RepositoryProgress {
  readonly phase: string
  readonly repository: string
}

export type RepositoryProgressReporter = (progress: RepositoryProgress) => void

export function reportProgress(
  reporter: RepositoryProgressReporter | undefined,
  progress: RepositoryProgress,
): void {
  try {
    reporter?.(progress)
  } catch {
    // Rendering progress must never change a repository operation's outcome.
  }
}
