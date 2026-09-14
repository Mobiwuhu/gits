import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

import type {
  CommandPresentation,
  RepoMirrorPresentation,
  UninstallPresentation,
} from '../types/index'

export interface ICliErrorService {
  command(command: string, error: unknown): CommandPresentation
  repoMirror(command: string, error: unknown, aborted: boolean): RepoMirrorPresentation
  uninstall(error: unknown, aborted: boolean): UninstallPresentation
}

export const ICliErrorService: IdentifierDecorator<ICliErrorService> =
  createIdentifier<ICliErrorService>('cli.errorService')
