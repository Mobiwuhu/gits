import type { GitOperationOptions, GitRepositoryGateway } from '../ports/git-repository-gateway.js'
import type {
  CommandError,
  RepositoryCommandResult,
  TaskRepository,
} from '../../domain/task/model.js'
import { gitCommandError, isGitCommandSuccessful } from './git-result.js'
import { commandError } from './repository-result.js'

export function checkoutDiffers(result: RepositoryCommandResult): boolean {
  return result.flags.includes('checkout-different')
}

export async function validateConfiguredCheckout(
  git: GitRepositoryGateway,
  path: string,
  repository: Pick<TaskRepository, 'checkout'>,
  options: GitOperationOptions = {},
): Promise<CommandError | null> {
  if (repository.checkout === null) return null

  const validation = await git.validateCheckoutPaths(path, repository.checkout, options)
  const failed = validation.commands.find((command) => !isGitCommandSuccessful(command))
  if (failed !== undefined) return gitCommandError(failed)
  if (validation.missingPaths.length === 0) return null

  return commandError(
    'checkout-path-missing',
    `Configured checkout ${validation.missingPaths.length === 1 ? 'directory does' : 'directories do'} not exist at HEAD: ${validation.missingPaths.join(', ')}`,
  )
}
