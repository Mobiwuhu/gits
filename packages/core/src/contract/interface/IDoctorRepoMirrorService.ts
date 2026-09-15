import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type {
  DoctorRepoMirrorsInput,
  RepoMirrorCommandOutput,
} from '../types/index'

export interface IDoctorRepoMirrorService {
  execute(input: DoctorRepoMirrorsInput): Promise<RepoMirrorCommandOutput>
}

export const IDoctorRepoMirrorService: IdentifierDecorator<IDoctorRepoMirrorService> =
  createIdentifier<IDoctorRepoMirrorService>('core.doctorRepoMirrorService')
