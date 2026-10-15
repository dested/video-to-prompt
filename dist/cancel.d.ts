/**
 * Cancellation. One error type, raised the moment the caller's signal fires,
 * from every wait the pipeline makes: a seek, a decode, a transcriber call. Its
 * message stays 'cancelled' because callers written against the first version
 * matched on that string; new code should use `isCancelled`.
 */
export declare class CancelledError extends Error {
    constructor();
}
export declare function throwIfAborted(signal: AbortSignal | undefined): void;
/** True for our own error, a platform AbortError, the legacy string, or any error raised after the signal fired. */
export declare function isCancelled(error: unknown, signal?: AbortSignal): boolean;
/** Reject as soon as `signal` fires; resolve with `work` otherwise. The work itself is not stopped. */
export declare function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T>;
