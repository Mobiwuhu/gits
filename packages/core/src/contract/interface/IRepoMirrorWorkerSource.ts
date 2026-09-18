import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

export const IRepoMirrorWorkerSource: IdentifierDecorator<string> =
  createIdentifier<string>('core.repoMirrorWorkerSource')
