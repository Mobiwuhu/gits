import type { RepositoryProgressReporter } from './taskProgress'
import type { RepoMirrorCommandOutput } from './repoMirror'

export interface InitializeTaskInput {
  readonly root: string
  readonly scanPath?: string
  readonly signal?: AbortSignal
}

export interface StatusTaskInput {
  readonly repositories: readonly string[]
  readonly root: string
  readonly signal?: AbortSignal
}

export interface FetchTaskInput {
  readonly interactive: boolean
  readonly jobs?: number
  readonly onProgress?: RepositoryProgressReporter
  readonly renderProgress?: boolean
  readonly repositories: readonly string[]
  readonly root: string
  readonly signal?: AbortSignal
}

export interface PushTaskInput {
  readonly all: boolean
  readonly dryRun: boolean
  readonly interactive: boolean
  readonly onProgress?: RepositoryProgressReporter
  readonly renderProgress?: boolean
  readonly repositories: readonly string[]
  readonly root: string
  readonly signal?: AbortSignal
}

export interface SwitchTaskInput {
  readonly interactive: boolean
  readonly jobs?: number
  readonly onStash?: (repository: string, reference: string) => void
  readonly onProgress?: RepositoryProgressReporter
  readonly renderProgress?: boolean
  readonly repositories: readonly string[]
  readonly root: string
  readonly signal?: AbortSignal
  readonly stash: boolean
}

export interface InstallTaskInput {
  readonly interactive: boolean
  readonly jobs?: number
  readonly onProgress?: RepositoryProgressReporter
  readonly renderProgress?: boolean
  readonly repositories: readonly string[]
  readonly root: string
  readonly signal?: AbortSignal
}

export interface AddTaskRepoMirrorsInput {
  readonly dryRun: boolean
  readonly jobs?: number
  readonly repositories: readonly string[]
  readonly root: string
  readonly schedule?: string
  readonly signal?: AbortSignal
}

export type AddTaskRepoMirrorsOutput = RepoMirrorCommandOutput
