export interface GitsPaths {
  readonly bin: string
  readonly config: string
  readonly dependencyState: string
  readonly home: string
  readonly installationId: string
  readonly locks: string
  readonly logs: string
  readonly mirrors: string
  readonly mirrorState: string
  readonly operations: string
  readonly state: string
  readonly templates: string
  readonly temporary: string
  readonly trash: string
}

export interface ResolveGitsPathsOptions {
  readonly environment?: NodeJS.ProcessEnv
  readonly userHome?: string
}
