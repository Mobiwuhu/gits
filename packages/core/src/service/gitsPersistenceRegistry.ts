import { isAbsolute, resolve } from 'node:path'

import { GitsPersistenceTargetKind } from '../contract/index'

export interface GitsHomePersistenceEntry {
  readonly description: string
  readonly kind: GitsPersistenceTargetKind.Directory | GitsPersistenceTargetKind.File
  readonly relativePath: string
}

export interface GitsHomePersistenceEntries {
  readonly bin: GitsHomePersistenceEntry
  readonly config: GitsHomePersistenceEntry
  readonly dependencyState: GitsHomePersistenceEntry
  readonly installationId: GitsHomePersistenceEntry
  readonly locks: GitsHomePersistenceEntry
  readonly logs: GitsHomePersistenceEntry
  readonly mirrors: GitsHomePersistenceEntry
  readonly mirrorState: GitsHomePersistenceEntry
  readonly operations: GitsHomePersistenceEntry
  readonly state: GitsHomePersistenceEntry
  readonly temporary: GitsHomePersistenceEntry
  readonly trash: GitsHomePersistenceEntry
}

export const gitsPersistenceRootRegistry = {
  defaultDirectoryName: '.gits',
  description: 'Exclusive machine-local data root owned by gits',
} as const

/**
 * The single source of truth for every machine-level path owned below GITS_HOME.
 * New persistent features must register their path here before writing to disk.
 */
export const gitsHomePersistenceRegistry: GitsHomePersistenceEntries = {
  bin: {
    description: 'Stable executables installed for native schedulers',
    kind: GitsPersistenceTargetKind.Directory,
    relativePath: 'bin',
  },
  config: {
    description: 'Machine-local gits configuration',
    kind: GitsPersistenceTargetKind.File,
    relativePath: 'config.jsonc',
  },
  dependencyState: {
    description: 'Repositories borrowing objects from repo mirrors',
    kind: GitsPersistenceTargetKind.Directory,
    relativePath: 'state/repo-mirror-dependencies',
  },
  installationId: {
    description: 'Installation ownership and scheduler identity',
    kind: GitsPersistenceTargetKind.File,
    relativePath: 'installation-id',
  },
  locks: {
    description: 'Cross-process lock targets',
    kind: GitsPersistenceTargetKind.Directory,
    relativePath: 'locks',
  },
  logs: {
    description: 'Bounded repo mirror runtime logs',
    kind: GitsPersistenceTargetKind.Directory,
    relativePath: 'logs/repo-mirrors',
  },
  mirrors: {
    description: 'Machine-local bare Git mirrors',
    kind: GitsPersistenceTargetKind.Directory,
    relativePath: 'repo-mirrors',
  },
  mirrorState: {
    description: 'Latest repo mirror run state',
    kind: GitsPersistenceTargetKind.Directory,
    relativePath: 'state/repo-mirrors',
  },
  operations: {
    description: 'Recoverable operation state',
    kind: GitsPersistenceTargetKind.Directory,
    relativePath: 'state/operations',
  },
  state: {
    description: 'Machine-local derived state',
    kind: GitsPersistenceTargetKind.Directory,
    relativePath: 'state',
  },
  temporary: {
    description: 'Transactional temporary files',
    kind: GitsPersistenceTargetKind.Directory,
    relativePath: 'tmp',
  },
  trash: {
    description: 'Recoverable removed mirrors',
    kind: GitsPersistenceTargetKind.Directory,
    relativePath: 'trash',
  },
}

export type GitsHomePersistenceKey = keyof GitsHomePersistenceEntries

export interface GitsExternalPersistenceRegistry {
  readonly launchdRepoMirrorJobs: {
    readonly description: string
    readonly directorySegments: readonly string[]
    readonly filePrefix: string
    readonly fileSuffix: string
    readonly kind: GitsPersistenceTargetKind.File
  }
  readonly systemdRepoMirrorJobs: {
    readonly description: string
    readonly directorySegments: readonly string[]
    readonly enablementDirectoryName: string
    readonly filePrefix: string
    readonly fileSuffixes: readonly string[]
    readonly kind: GitsPersistenceTargetKind.File
  }
}

export const gitsExternalPersistenceRegistry: GitsExternalPersistenceRegistry = {
  launchdRepoMirrorJobs: {
    description: 'macOS user LaunchAgent projections',
    directorySegments: ['Library', 'LaunchAgents'],
    filePrefix: 'io.gits.repo-mirror.',
    fileSuffix: '.plist',
    kind: GitsPersistenceTargetKind.File,
  },
  systemdRepoMirrorJobs: {
    description: 'Linux systemd user service and timer projections',
    directorySegments: ['systemd', 'user'],
    enablementDirectoryName: 'timers.target.wants',
    filePrefix: 'gits-repo-mirror-',
    fileSuffixes: ['.service', '.timer'],
    kind: GitsPersistenceTargetKind.File,
  },
}

export interface GitsManagedArtifactRegistry {
  readonly stableSchedulerRunner: {
    readonly description: string
    readonly fileName: string
    readonly parent: GitsHomePersistenceKey
  }
}

export const gitsManagedArtifactRegistry: GitsManagedArtifactRegistry = {
  stableSchedulerRunner: {
    description: 'Stable native scheduler runner',
    fileName: 'gits-repo-mirror-runner',
    parent: 'bin',
  },
}

export function resolveRegisteredGitsHomePath(home: string, key: GitsHomePersistenceKey): string {
  return resolve(home, gitsHomePersistenceRegistry[key].relativePath)
}

export function resolveLaunchdProjectionDirectory(userHome: string): string {
  return resolve(
    userHome,
    ...gitsExternalPersistenceRegistry.launchdRepoMirrorJobs.directorySegments,
  )
}

export function resolveSystemdUserUnitDirectory(
  environment: NodeJS.ProcessEnv,
  userHome: string,
): string {
  const configured = environment.XDG_CONFIG_HOME
  if (configured !== undefined && !isAbsolute(configured)) {
    throw new Error('XDG_CONFIG_HOME must be an absolute path for native scheduling.')
  }
  return resolve(
    configured ?? resolve(userHome, '.config'),
    ...gitsExternalPersistenceRegistry.systemdRepoMirrorJobs.directorySegments,
  )
}

export function resolveSystemdTimerEnablementDirectory(
  environment: NodeJS.ProcessEnv,
  userHome: string,
): string {
  return resolve(
    resolveSystemdUserUnitDirectory(environment, userHome),
    gitsExternalPersistenceRegistry.systemdRepoMirrorJobs.enablementDirectoryName,
  )
}

export function registeredTopLevelNames(): ReadonlySet<string> {
  return new Set(
    Object.values(gitsHomePersistenceRegistry).map(
      (entry) => entry.relativePath.split('/')[0] ?? entry.relativePath,
    ),
  )
}
