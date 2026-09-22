export enum GitsPersistenceTargetKind {
  DataRoot = 'data-root',
  Directory = 'directory',
  File = 'file',
  NativeProjection = 'native-projection',
  Unregistered = 'unregistered',
}

export enum GitsPersistenceTargetScope {
  External = 'external',
  GitsHome = 'gits-home',
}
