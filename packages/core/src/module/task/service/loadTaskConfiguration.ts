import type { ITaskConfigurationService } from '../../../contract/index'
import { ConfigurationError, IncompleteConfigurationError } from '../../../contract/index'
import { isRepositoryIncomplete, type TaskConfiguration } from '../../../contract/index'

export interface BranchNameValidator {
  checkRefFormat(
    branch: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly aborted: boolean; readonly exitCode: number | null }>
}

export interface LoadTaskConfigurationInput {
  readonly allowIncomplete?: boolean
  readonly root: string
  readonly signal?: AbortSignal
}

export async function loadTaskConfiguration(
  store: ITaskConfigurationService,
  branchValidator: BranchNameValidator,
  input: LoadTaskConfigurationInput,
): Promise<TaskConfiguration> {
  const { configuration } = await store.load(input.root)
  const placeholders = configuration.repositories.filter((repository) =>
    isRepositoryIncomplete(repository),
  )

  if (placeholders.length > 0 && !input.allowIncomplete) {
    throw new IncompleteConfigurationError(placeholders)
  }

  const repositoriesForReferenceValidation = input.allowIncomplete
    ? configuration.repositories.filter((repository) => !isRepositoryIncomplete(repository))
    : configuration.repositories
  await validateBranchNames(repositoriesForReferenceValidation, branchValidator, input.signal)
  return configuration
}

async function validateBranchNames(
  repositories: readonly TaskConfiguration['repositories'][number][],
  branchValidator: BranchNameValidator,
  signal: AbortSignal | undefined,
): Promise<void> {
  const candidates = repositories.flatMap((repository) => [
    repository.branch,
    repository.from.slice('origin/'.length),
  ])
  const uniqueCandidates = [...new Set(candidates)]
  const options = signal ? { signal } : {}
  const checks = await Promise.all(
    uniqueCandidates.map(async (branch) => ({
      branch,
      valid: isValidReference(await branchValidator.checkRefFormat(branch, options)),
    })),
  )
  const invalid = checks.filter((check) => !check.valid).map((check) => check.branch)

  if (invalid.length > 0) {
    throw new ConfigurationError(`Invalid Git branch names: ${invalid.join(', ')}`)
  }
}

function isValidReference(result: {
  readonly aborted: boolean
  readonly exitCode: number | null
}): boolean {
  return !result.aborted && result.exitCode === 0
}
