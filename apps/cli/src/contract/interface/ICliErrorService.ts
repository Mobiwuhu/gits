import type { TaskTemplateCommandName } from '@usegits/core'
import { createIdentifier } from '@wendellhu/redi'
import type { IdentifierDecorator } from '@wendellhu/redi'

import type {
  CommandPresentation,
  RepoMirrorPresentation,
  TaskTemplatePresentation,
  UninstallPresentation,
} from '../types/index'

export interface ICliErrorService {
  command(command: string, error: unknown): CommandPresentation
  repoMirror(
    command: string,
    error: unknown,
    aborted: boolean
  ): RepoMirrorPresentation
  taskTemplate(
    command: TaskTemplateCommandName,
    error: unknown,
    aborted: boolean
  ): TaskTemplatePresentation
  uninstall(error: unknown, aborted: boolean): UninstallPresentation
}

export const ICliErrorService: IdentifierDecorator<ICliErrorService> =
  createIdentifier<ICliErrorService>('cli.errorService')
