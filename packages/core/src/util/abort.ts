export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    const error = new Error('Operation aborted.')
    error.name = 'AbortError'
    throw error
  }
}

export function signalOptions(signal: AbortSignal | undefined): {
  readonly signal?: AbortSignal
} {
  return signal === undefined ? {} : { signal }
}
