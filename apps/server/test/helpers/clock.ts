import { performance } from "node:perf_hooks";

import type { Clock } from "../../src/clock.js";

/**
 * A clock whose first reading is 0 and whose later readings run in real time from `jumpMs`:
 * as if `jumpMs` passed between the first reading (a send's admission, just before its insert)
 * and everything after it, e.g. a commit that took that long. Use it for one send per app.
 */
export function clockJumpingAfterFirstReading(jumpMs: number): Clock {
  let base: number | undefined;
  return {
    monotonicNow() {
      if (base === undefined) {
        base = performance.now();
        return 0;
      }
      return jumpMs + (performance.now() - base);
    },
  };
}
