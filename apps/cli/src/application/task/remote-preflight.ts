import type { GitOperationOptions, GitRepositoryGateway } from '../ports/git-repository-gateway.js'
import { getGitUrlHost } from '../../domain/git/remote-url.js'
import type { CommandError, TaskRepository } from '../../domain/task/model.js'
import { gitCommandError, isGitCommandSuccessful } from './git-result.js'

export async function preflightRemotes(
  git: GitRepositoryGateway,
  repositories: readonly TaskRepository[],
  options: GitOperationOptions,
): Promise<ReadonlyMap<string, CommandError>> {
  const hosts = new Map<string, TaskRepository>()
  for (const repository of repositories) {
    const host = getGitUrlHost(repository.url) ?? repository.url
    if (!hosts.has(host)) hosts.set(host, repository)
  }

  const failures = new Map<string, CommandError>()
  for (const [host, repository] of hosts) {
    const result = await git.probeRemote(repository.url, options)
    if (!isGitCommandSuccessful(result)) {
      const failure = gitCommandError(result)
      const code =
        options.interactive === true || !looksLikeAuthenticationFailure(failure.message)
          ? failure.code
          : 'auth-required'
      failures.set(host, {
        code,
        message:
          options.interactive === true
            ? failure.message
            : code === 'auth-required'
              ? `Remote preflight for ${host} requires authentication: ${failure.message}`
              : `Remote preflight for ${host} failed: ${failure.message}`,
      })
    }
  }

  return failures
}

export function remoteFailureFor(
  failures: ReadonlyMap<string, CommandError>,
  repository: TaskRepository,
): CommandError | undefined {
  return failures.get(getGitUrlHost(repository.url) ?? repository.url)
}

function looksLikeAuthenticationFailure(message: string): boolean {
  return /authentication|could not read username|host key verification|permission denied|publickey|terminal prompts disabled/iu.test(
    message,
  )
}
