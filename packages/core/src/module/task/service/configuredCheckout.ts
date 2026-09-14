import {
  RepositoryFlag,
  type CommandError,
  type GitOperationOptions,
  type IGitService,
  type RepositoryCommandResult,
  type TaskRepository,
} from '../../../contract/index'
import { gitCommandError, isGitCommandSuccessful } from './gitResult'
import { commandError } from './taskResult'

export function checkoutDiffers(result: RepositoryCommandResult): boolean {
  return result.flags.includes(RepositoryFlag.CheckoutDifferent)
}

export async function validateConfiguredCheckout(
  git: IGitService,
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
