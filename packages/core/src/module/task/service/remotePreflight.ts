import type {
  GitOperationOptions,
  IGitService,
  CommandError,
  TaskRepository,
} from '../../../contract/index'
import { getGitUrlHost } from '../../../service/gitUrl'
import { gitCommandError, isGitCommandSuccessful } from './gitResult'

export async function preflightRemotes(
  git: IGitService,
  repositories: readonly TaskRepository[],
  options: GitOperationOptions
): Promise<ReadonlyMap<string, CommandError>> {
  const hosts = new Map<string, TaskRepository>()
  for (const repository of repositories) {
    const host = getGitUrlHost(repository.url) ?? repository.url
    if (!hosts.has(host)) {
      hosts.set(host, repository)
    }
  }

  const failures = new Map<string, CommandError>()
  for (const [host, repository] of hosts) {
    const result = await git.probeRemote(repository.url, options)
    if (!isGitCommandSuccessful(result)) {
      const { code: originalCode, message: failureMessage } =
        gitCommandError(result)
      const code =
        options.interactive === true ||
        !looksLikeAuthenticationFailure(failureMessage)
          ? originalCode
          : 'auth-required'
      let message = `Remote preflight for ${host} failed: ${failureMessage}`
      if (code === 'auth-required') {
        message = `Remote preflight for ${host} requires authentication: ${failureMessage}`
      }
      if (options.interactive === true) {
        message = failureMessage
      }
      failures.set(host, {
        code,
        message,
      })
    }
  }

  return failures
}

export function remoteFailureFor(
  failures: ReadonlyMap<string, CommandError>,
  repository: TaskRepository
): CommandError | undefined {
  return failures.get(getGitUrlHost(repository.url) ?? repository.url)
}

function looksLikeAuthenticationFailure(message: string): boolean {
  return /authentication|could not read username|host key verification|permission denied|publickey|terminal prompts disabled/iu.test(
    message
  )
}
