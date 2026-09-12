import type { RepoMirrorLastRunStatus, RepoMirrorRunState } from '../../domain/repo-mirror/model.js'

export interface RepoMirrorLogSession {
  readonly startedAt: string
  event(command: Readonly<{ durationMs: number; exitCode: number | null }>): void
  finish(
    status: RepoMirrorLastRunStatus,
    options?: Readonly<{ error?: string }>,
  ): Promise<RepoMirrorRunState>
}

export interface RepoMirrorLogger {
  readLastRun(name: string): Promise<RepoMirrorRunState | null>
  readLines(name: string, maximum: number): Promise<readonly string[]>
  start(name: string, source: 'manual' | 'scheduler'): Promise<RepoMirrorLogSession>
}
