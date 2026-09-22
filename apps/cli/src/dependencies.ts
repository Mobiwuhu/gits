import { IConcurrencyPresentationService } from '@usegits/core'
import type { Dependency } from '@wendellhu/redi'

import {
  ICliApplication,
  ICliCommand,
  ICliConfirmationService,
  ICliErrorService,
  ICliOutputService,
  ICliRuntimeService,
  IRepoMirrorSubcommand,
  ITaskTemplateSubcommand,
} from './contract/index'
import {
  AddTaskTemplateCommand,
  AddRepoMirrorCommand,
  DoctorRepoMirrorCommand,
  FetchRepoMirrorCommand,
  FetchTaskCommand,
  GetRepoMirrorLogsCommand,
  GetRepoMirrorPathCommand,
  InitializeTaskCommand,
  InstallTaskCommand,
  ListRepoMirrorCommand,
  ListTaskTemplateCommand,
  PushTaskCommand,
  RemoveRepoMirrorCommand,
  RemoveTaskTemplateCommand,
  RenameTaskTemplateCommand,
  RepoMirrorCommand,
  SetRepoMirrorCommand,
  StatusTaskCommand,
  SwitchTaskCommand,
  TaskTemplateCommand,
  UninstallCommand,
  UpdateTaskTemplateCommand,
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
  [ICliCommand, { useClass: TaskTemplateCommand }],
  [ICliCommand, { useClass: UninstallCommand }],

  [IRepoMirrorSubcommand, { useClass: AddRepoMirrorCommand }],
  [IRepoMirrorSubcommand, { useClass: ListRepoMirrorCommand }],
  [IRepoMirrorSubcommand, { useClass: GetRepoMirrorPathCommand }],
  [IRepoMirrorSubcommand, { useClass: GetRepoMirrorLogsCommand }],
  [IRepoMirrorSubcommand, { useClass: SetRepoMirrorCommand }],
  [IRepoMirrorSubcommand, { useClass: FetchRepoMirrorCommand }],
  [IRepoMirrorSubcommand, { useClass: RemoveRepoMirrorCommand }],
  [IRepoMirrorSubcommand, { useClass: DoctorRepoMirrorCommand }],

  [ITaskTemplateSubcommand, { useClass: AddTaskTemplateCommand }],
  [ITaskTemplateSubcommand, { useClass: ListTaskTemplateCommand }],
  [ITaskTemplateSubcommand, { useClass: UpdateTaskTemplateCommand }],
  [ITaskTemplateSubcommand, { useClass: RenameTaskTemplateCommand }],
  [ITaskTemplateSubcommand, { useClass: RemoveTaskTemplateCommand }],
]
