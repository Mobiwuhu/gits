import { coreDependencies, IRepoMirrorWorkerSource } from '@usegit/core'
import { Injector } from '@wendellhu/redi'

import { cliDependencies } from '../dependencies'

export function createContainer(schedulerWorkerSource: string): Injector {
  return new Injector([
    ...coreDependencies,
    ...cliDependencies,
    [IRepoMirrorWorkerSource, { useValue: schedulerWorkerSource }],
  ])
}
