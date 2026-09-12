export interface TaskScaffold {
  ensure(root: string): Promise<void>
}
