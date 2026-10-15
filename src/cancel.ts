/**
 * Cancellation. One error type, raised the moment the caller's signal fires,
 * from every wait the pipeline makes: a seek, a decode, a transcriber call. Its
 * message stays 'cancelled' because callers written against the first version
 * matched on that string; new code should use `isCancelled`.
 */

export class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'AbortError'
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CancelledError()
}

/** True for our own error, a platform AbortError, the legacy string, or any error raised after the signal fired. */
export function isCancelled(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (error instanceof CancelledError) return true
  if (error instanceof DOMException && error.name === 'AbortError') return true
  return error instanceof Error && error.message === 'cancelled'
}

/** Reject as soon as `signal` fires; resolve with `work` otherwise. The work itself is not stopped. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(new CancelledError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CancelledError())
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}
