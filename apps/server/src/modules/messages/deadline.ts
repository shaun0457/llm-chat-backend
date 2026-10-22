/**
 * Whole milliseconds left of a deadline that started at monotonic time `t0`, rounded down so
 * that a timer set from it never fires after the deadline. 0 means no time is left (also when
 * less than one millisecond remains, or the deadline has passed).
 */
export function remainingMs(deadlineMs: number, t0: number, now: number): number {
  return Math.max(0, Math.floor(deadlineMs - (now - t0)));
}
