import { performance } from "node:perf_hooks";

/**
 * A monotonic clock in milliseconds (may be fractional), for durations measured inside this
 * process: generation deadlines, terminal-write budgets, latency. It is never compared with
 * the database clock, which decides everything stored in rows.
 */
export type Clock = { monotonicNow(): number };

export const systemClock: Clock = { monotonicNow: () => performance.now() };
