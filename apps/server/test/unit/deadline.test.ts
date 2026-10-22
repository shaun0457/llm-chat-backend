import { describe, expect, it } from "vitest";

import { remainingMs } from "../../src/modules/messages/deadline.js";

describe("remainingMs", () => {
  it("rounds a fractional remainder down, never extending the deadline", () => {
    expect(remainingMs(1_000, 10.5, 759.75)).toBe(250);
  });

  it("is 0 when the deadline is reached exactly", () => {
    expect(remainingMs(1_000, 0, 1_000)).toBe(0);
  });

  it("is 0 when less than a whole millisecond remains", () => {
    expect(remainingMs(1_000, 0, 999.25)).toBe(0);
  });

  it("is 0, never negative, once the deadline has passed", () => {
    expect(remainingMs(1_000, 0, 5_000)).toBe(0);
  });

  it("works with a large monotonic origin", () => {
    const t0 = 9_007_199_254.125;

    expect(remainingMs(180_000, t0, t0 + 30_000.5)).toBe(149_999);
  });

  it("is the whole deadline when no time has passed", () => {
    expect(remainingMs(180_000, 42.5, 42.5)).toBe(180_000);
  });
});
