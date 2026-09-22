export const builtInTaskTemplateName = 'default'
export const taskTemplateSelectionPolicy = 'gitignore-v1'

export enum TaskTemplateKind {
  BuiltIn = 'built-in',
  Local = 'local',
}

export enum TaskTemplateState {
  Planned = 'planned',
  Ready = 'ready',
  Removed = 'removed',
  Unhealthy = 'unhealthy',
}

export enum TaskTemplateAction {
  Added = 'added',
  Listed = 'listed',
  Removed = 'removed',
  Renamed = 'renamed',
  Updated = 'updated',
}

export enum TaskTemplateCommandName {
  Add = 'template add',
  List = 'template list',
  Remove = 'template remove',
  Rename = 'template rename',
  Update = 'template update',
}

export enum TaskDirectoryEntryKind {
  Directory = 'directory',
  File = 'file',
  Symlink = 'symlink',
}

export enum TaskDirectorySourcePolicy {
  NamedTemplate = 'named-template',
  OneOffImport = 'one-off-import',
  StoredTemplate = 'stored-template',
}

export enum InitializeTaskTemplateKind {
  BuiltIn = 'built-in',
  Directory = 'directory',
  Local = 'local',
}
