/** What withTimeout() resolves with when the time ran out first. */
export const TIMED_OUT: unique symbol = Symbol("timed out");

/**
 * `promise`'s value, or TIMED_OUT once `ms` have passed first (at once when `ms` ≤ 0). A
 * rejection of `promise` within the time propagates. The timer never outlives the call; a
 * promise left behind keeps running, and its later outcome is ignored by this call.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  if (ms <= 0) {
    return TIMED_OUT;
  }
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(resolve, ms, TIMED_OUT);
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `promise`'s outcome, or a rejection with `signal.reason` as soon as the signal aborts
 * (immediately when it already has). For work that does not take a signal itself; the work
 * left behind keeps running, and a later rejection of it is swallowed.
 */
export async function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => {});
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
