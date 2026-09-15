import type { GitCommandResult, CommandError } from '../../../contract/index'

export function gitCommandError(result: GitCommandResult): CommandError {
  const output = result.stderr.trim() || result.stdout.trim()
  return {
    code: result.aborted ? 'interrupted' : 'git-command-failed',
    message:
      output ||
      `git ${result.args.join(' ')} ${
        result.aborted
          ? 'was interrupted'
          : `exited with code ${result.exitCode ?? 'unknown'}`
      }`,
  }
}

export function isGitCommandSuccessful(result: GitCommandResult): boolean {
  return !result.aborted && result.exitCode === 0
}
