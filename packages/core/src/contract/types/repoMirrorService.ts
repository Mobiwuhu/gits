import type {
  RepoMirrorAction,
  RepoMirrorInvocationSource,
} from '../constants/repoMirror'
import type { RepoMirrorCommandError, RepoMirrorView } from './repoMirror'

export interface ListRepoMirrorsInput {
  readonly includeSize?: boolean
  readonly names: readonly string[]
}

export interface GetRepoMirrorPathInput {
  readonly name: string
}

export interface GetRepoMirrorLogsInput {
  readonly lines: number
  readonly name: string
}

export interface FollowRepoMirrorLogsInput extends GetRepoMirrorLogsInput {
  readonly signal: AbortSignal
}

export interface AddRepoMirrorsInput {
  readonly aliases: readonly string[]
  readonly dryRun: boolean
  readonly jobs?: number
  readonly name?: string
  readonly schedule?: string
  readonly signal?: AbortSignal
  readonly urls: readonly string[]
}

export interface SetRepoMirrorsInput {
  readonly addAliases: readonly string[]
  readonly jobs?: number
  readonly names: readonly string[]
  readonly removeAliases: readonly string[]
  readonly schedule?: string
  readonly signal?: AbortSignal
  readonly url?: string
}

export interface FetchRepoMirrorsInput {
  readonly jobs?: number
  readonly maintenance: boolean
  readonly names: readonly string[]
  readonly signal?: AbortSignal
  readonly source: RepoMirrorInvocationSource
}

export interface RemoveRepoMirrorsInput {
  readonly confirmed: boolean
  readonly detachDependents: boolean
  readonly force: boolean
  readonly jobs?: number
  readonly names: readonly string[]
  readonly purge: boolean
  readonly signal?: AbortSignal
}

export interface DoctorRepoMirrorsInput {
  readonly confirmed: boolean
  readonly deep: boolean
  readonly fix: boolean
  readonly names: readonly string[]
  readonly remote: boolean
  readonly signal?: AbortSignal
}

export interface RepoMirrorViewOverrides {
  readonly action?: RepoMirrorAction
  readonly dependents?: readonly string[]
  readonly error?: RepoMirrorCommandError | null
  readonly forced?: boolean
  readonly repositoryState?: RepoMirrorView['repositoryState']
}
