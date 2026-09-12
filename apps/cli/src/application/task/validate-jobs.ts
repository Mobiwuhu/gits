import { UsageError } from '../../domain/task/errors.js'

export function validateJobs(jobs: number | undefined): void {
  if (jobs !== undefined && (!Number.isInteger(jobs) || jobs < 1)) {
    throw new UsageError('--jobs must be a positive integer.')
  }
}
