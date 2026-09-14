export enum GitsPersistenceTargetKind {
  DataRoot = 'data-root',
  Directory = 'directory',
  File = 'file',
  NativeProjection = 'native-projection',
  Unregistered = 'unregistered',
}

export enum GitsPersistenceTargetScope {
  External = 'external',
  GitsHome = 'gits-home',
}

export interface GitsPersistenceTarget {
  readonly description: string
  readonly exists: boolean
  readonly id: string
  readonly kind: GitsPersistenceTargetKind
  readonly path: string
  readonly scope: GitsPersistenceTargetScope
}

export interface GitsPersistencePurgeResult {
  readonly removedPaths: readonly string[]
  readonly warnings: readonly string[]
}

export interface GitsUninstallMirror {
  readonly dependents: readonly string[]
  readonly name: string
  readonly path: string
}

export interface GitsUninstallPlan {
  readonly mirrors: readonly GitsUninstallMirror[]
  readonly targets: readonly GitsPersistenceTarget[]
  readonly warnings: readonly string[]
}

export interface GitsUninstallOutput extends GitsUninstallPlan {
  readonly command: 'uninstall'
  readonly dryRun: boolean
  readonly ok: boolean
  readonly removedMirrors: readonly string[]
  readonly removedPaths: readonly string[]
}

export interface UninstallGitsInput {
  readonly confirmed: boolean
  readonly detachDependents: boolean
  readonly dryRun: boolean
  readonly force: boolean
  readonly signal?: AbortSignal
}
