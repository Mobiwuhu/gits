import { IConcurrencyPresentationService } from '@usegit/core'
import type { Dependency } from '@wendellhu/redi'

import {
  ICliApplication,
  ICliCommand,
  ICliConfirmationService,
  ICliErrorService,
  ICliOutputService,
  ICliRuntimeService,
  IRepoMirrorSubcommand,
} from './contract/index'
import {
  AddRepoMirrorCommand,
  DoctorRepoMirrorCommand,
  FetchRepoMirrorCommand,
  FetchTaskCommand,
  GetRepoMirrorLogsCommand,
  GetRepoMirrorPathCommand,
  InitializeTaskCommand,
  InstallTaskCommand,
  ListRepoMirrorCommand,
  PushTaskCommand,
  RemoveRepoMirrorCommand,
  RepoMirrorCommand,
  SetRepoMirrorCommand,
  StatusTaskCommand,
  SwitchTaskCommand,
  UninstallCommand,
} from './module/index'
import {
  CliApplication,
  CliConfirmationService,
  CliErrorService,
  CliOutputService,
  CliProgressService,
  CliRuntimeService,
} from './service/index'

export const cliDependencies: Dependency[] = [
  [ICliApplication, { useClass: CliApplication }],
  [ICliConfirmationService, { useClass: CliConfirmationService }],
  [ICliErrorService, { useClass: CliErrorService }],
  [ICliOutputService, { useClass: CliOutputService }],
  [ICliRuntimeService, { useClass: CliRuntimeService }],
  [IConcurrencyPresentationService, { useClass: CliProgressService }],

  [ICliCommand, { useClass: InitializeTaskCommand }],
  [ICliCommand, { useClass: InstallTaskCommand }],
  [ICliCommand, { useClass: StatusTaskCommand }],
  [ICliCommand, { useClass: FetchTaskCommand }],
  [ICliCommand, { useClass: SwitchTaskCommand }],
  [ICliCommand, { useClass: PushTaskCommand }],
  [ICliCommand, { useClass: RepoMirrorCommand }],
  [ICliCommand, { useClass: UninstallCommand }],

  [IRepoMirrorSubcommand, { useClass: AddRepoMirrorCommand }],
  [IRepoMirrorSubcommand, { useClass: ListRepoMirrorCommand }],
  [IRepoMirrorSubcommand, { useClass: GetRepoMirrorPathCommand }],
  [IRepoMirrorSubcommand, { useClass: GetRepoMirrorLogsCommand }],
  [IRepoMirrorSubcommand, { useClass: SetRepoMirrorCommand }],
  [IRepoMirrorSubcommand, { useClass: FetchRepoMirrorCommand }],
  [IRepoMirrorSubcommand, { useClass: RemoveRepoMirrorCommand }],
  [IRepoMirrorSubcommand, { useClass: DoctorRepoMirrorCommand }],
]
