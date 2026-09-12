import { GitsError } from '../../domain/task/errors.js'

export async function runInterruptibly<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const interrupt = (): void => controller.abort()
  process.once('SIGINT', interrupt)

  try {
    const value = await action(controller.signal)
    if (controller.signal.aborted) {
      throw new GitsError('interrupted', 'Command interrupted by user.', 130)
    }
    return value
  } finally {
    process.removeListener('SIGINT', interrupt)
  }
}
