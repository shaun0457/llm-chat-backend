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
    // Not raced, so nothing else observes a later rejection of the promise left behind.
    promise.catch(() => {});
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

/**
 * untilAbort for a series of promises with one abort listener between them all: `race()` is
 * `promise`'s outcome or a rejection with `signal.reason` once the signal aborts (at once when
 * it already has); `dispose()` removes the listener. Only races still pending are remembered,
 * so a long series holds nothing of the settled ones. A promise left behind keeps running, and
 * its later rejection is swallowed.
 */
export function abortRace(signal: AbortSignal): {
  race<T>(promise: Promise<T>): Promise<T>;
  dispose(): void;
} {
  const pending = new Set<(reason: unknown) => void>();
  const onAbort = (): void => {
    for (const reject of pending) {
      reject(signal.reason);
    }
    pending.clear();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    race<T>(promise: Promise<T>): Promise<T> {
      promise.catch(() => {});
      // Checked first: once aborted, even an already settled promise does not win.
      if (signal.aborted) {
        return Promise.reject(signal.reason);
      }
      return new Promise<T>((resolve, reject) => {
        pending.add(reject);
        promise.then(
          (value) => {
            pending.delete(reject);
            resolve(value);
          },
          (error: unknown) => {
            pending.delete(reject);
            reject(error);
          },
        );
      });
    },
    dispose() {
      signal.removeEventListener("abort", onAbort);
      pending.clear();
    },
  };
}
