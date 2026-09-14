import { coreDependencies } from '@gits/core'
import { Injector } from '@wendellhu/redi'

import { cliDependencies } from '../dependencies'

export function createContainer(): Injector {
  return new Injector([...coreDependencies, ...cliDependencies])
}
