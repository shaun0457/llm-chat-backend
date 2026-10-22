import { afterEach, describe, expect, it, vi } from "vitest";

import { TIMED_OUT, untilAbort, withTimeout } from "../../src/modules/messages/race.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("resolves with the value when the promise settles first, leaving no timer", async () => {
    vi.useFakeTimers();

    await expect(withTimeout(Promise.resolve(7), 1_000)).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves with TIMED_OUT once the time runs out first", async () => {
    vi.useFakeTimers();
    const result = withTimeout(new Promise<never>(() => {}), 1_000);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toBe(TIMED_OUT);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out at once when no time is left", async () => {
    await expect(withTimeout(new Promise<never>(() => {}), 0)).resolves.toBe(TIMED_OUT);
  });

  it("propagates a rejection that arrives in time", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1_000)).rejects.toThrow("boom");
  });
});

describe("untilAbort", () => {
  it("resolves with the value when the signal does not abort", async () => {
    const controller = new AbortController();

    await expect(untilAbort(Promise.resolve("x"), controller.signal)).resolves.toBe("x");
  });

  it("rejects with the abort reason as soon as the signal aborts", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    const result = untilAbort(new Promise<never>(() => {}), controller.signal);

    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
  });

  it("rejects at once when the signal already aborted, swallowing the work's later rejection", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    controller.abort(reason);
    let rejectWork: (error: Error) => void = () => {};
    const work = new Promise<never>((_resolve, reject) => {
      rejectWork = reject;
    });

    await expect(untilAbort(work, controller.signal)).rejects.toBe(reason);
    rejectWork(new Error("late"));
  });
});
