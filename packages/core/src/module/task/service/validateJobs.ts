import { UsageError } from '../../../contract/index'

export function validateJobs(jobs: number | undefined): void {
  if (jobs !== undefined && (!Number.isInteger(jobs) || jobs < 1)) {
    throw new UsageError('--jobs must be a positive integer.')
  }
}
