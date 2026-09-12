import type { GitRepositoryGateway } from '../../application/ports/git-repository-gateway.js'
import { GitsUninstaller } from '../../application/uninstall/gits-uninstaller.js'
import type { RepoMirrorDependencies } from '../../application/ports/repo-mirror-dependencies.js'
import type { RepoMirrorResolver } from '../../application/ports/repo-mirror-resolver.js'
import type { TaskConfigurationStore } from '../../application/ports/task-configuration-store.js'
import type { TaskScaffold } from '../../application/ports/task-scaffold.js'
import type { TaskTemplateImporter } from '../../application/ports/task-template-importer.js'
import { JsoncTaskConfigurationStore } from '../../infrastructure/config/jsonc-task-configuration-store.js'
import { PinoRepoMirrorLogger } from '../../infrastructure/logging/pino-repo-mirror-logger.js'
import { NodeGitsPersistence } from '../../infrastructure/persistence/node-gits-persistence.js'
import { NodeTaskScaffold } from '../../infrastructure/filesystem/node-task-scaffold.js'
import { NodeTaskTemplateImporter } from '../../infrastructure/filesystem/node-task-template-importer.js'
import { createGitRepositoryGateway } from '../../infrastructure/git/git-repository.js'
import { ConfiguredRepoMirrorResolver } from '../../application/repo-mirrors/configured-repo-mirror-resolver.js'
import { RepoMirrorManager } from '../../application/repo-mirrors/repo-mirror-manager.js'
import { GitRepoMirrorGateway } from '../../infrastructure/repo-mirrors/git-repo-mirror-gateway.js'
import { resolveGitsPaths } from '../../infrastructure/repo-mirrors/gits-paths.js'
import { JsoncRepoMirrorStore } from '../../infrastructure/repo-mirrors/jsonc-repo-mirror-store.js'
import { ProperLockfile2RepoMirrorLock } from '../../infrastructure/repo-mirrors/proper-lockfile2-repo-mirror-lock.js'
import { RepoMirrorDependencyRegistry } from '../../infrastructure/repo-mirrors/repo-mirror-dependency-registry.js'
import { NativeRepoMirrorScheduler } from '../../infrastructure/scheduler/native-repo-mirror-scheduler.js'

export interface ApplicationServices {
  readonly configurationStore: TaskConfigurationStore
  readonly git: GitRepositoryGateway
  readonly repoMirrorDependencies: RepoMirrorDependencies
  readonly repoMirrorManager: RepoMirrorManager
  readonly repoMirrorResolver: RepoMirrorResolver
  readonly scaffold: TaskScaffold
  readonly templateImporter: TaskTemplateImporter
  readonly uninstaller: GitsUninstaller
}

let configuredServices: ApplicationServices | undefined

export function getApplicationServices(): ApplicationServices {
  configuredServices ??= createApplicationServices()
  return configuredServices
}

export function setApplicationServicesForTesting(services: ApplicationServices | undefined): void {
  configuredServices = services
}

function createApplicationServices(): ApplicationServices {
  const paths = resolveGitsPaths()
  const mirrorGateway = new GitRepoMirrorGateway()
  const mirrorStore = new JsoncRepoMirrorStore(paths)
  const mirrorLock = new ProperLockfile2RepoMirrorLock(paths)
  const mirrorDependencies = new RepoMirrorDependencyRegistry(paths, mirrorGateway)
  const mirrorLogger = new PinoRepoMirrorLogger(paths)
  const mirrorScheduler = new NativeRepoMirrorScheduler(paths)
  const repoMirrorManager = new RepoMirrorManager({
    dependencies: mirrorDependencies,
    gateway: mirrorGateway,
    lock: mirrorLock,
    logger: mirrorLogger,
    paths,
    scheduler: mirrorScheduler,
    store: mirrorStore,
  })
  const uninstaller = new GitsUninstaller({
    dependencies: mirrorDependencies,
    persistence: new NodeGitsPersistence(paths),
    repoMirrors: repoMirrorManager,
    store: mirrorStore,
  })
  return {
    configurationStore: new JsoncTaskConfigurationStore(),
    git: createGitRepositoryGateway(),
    repoMirrorDependencies: mirrorDependencies,
    repoMirrorManager,
    repoMirrorResolver: new ConfiguredRepoMirrorResolver(
      mirrorStore,
      mirrorGateway,
      mirrorLock,
      paths,
    ),
    scaffold: new NodeTaskScaffold(),
    templateImporter: new NodeTaskTemplateImporter(),
    uninstaller,
  }
}
