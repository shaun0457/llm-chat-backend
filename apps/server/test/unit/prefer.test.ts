import { describe, expect, it } from "vitest";

import {
  effectiveWaitMs,
  parsePrefer,
  preferenceApplied,
} from "../../src/modules/messages/prefer.js";

const none = { respondAsync: false, waitSeconds: null };

describe("prefer.parse", () => {
  it.each([
    [[], none],
    [[""], none],
    [["wait=5"], { respondAsync: false, waitSeconds: 5 }],
    [["WAIT=5"], { respondAsync: false, waitSeconds: 5 }],
    [["Respond-Async"], { respondAsync: true, waitSeconds: null }],
    [["respond-async, wait=5"], { respondAsync: true, waitSeconds: 5 }],
    [["wait=5, respond-async"], { respondAsync: true, waitSeconds: 5 }],
    [["wait=0"], { respondAsync: false, waitSeconds: 0 }],
    [["wait=007"], { respondAsync: false, waitSeconds: 7 }],
    [['wait="7"'], { respondAsync: false, waitSeconds: 7 }],
    [["wait = 5"], { respondAsync: false, waitSeconds: 5 }],
    [["  wait=5  ,  respond-async  "], { respondAsync: true, waitSeconds: 5 }],
  ])("%j → %j", (values, expected) => {
    expect(parsePrefer(values)).toEqual(expected);
  });

  it("joins every header line", () => {
    expect(parsePrefer(["respond-async", "wait=5"])).toEqual({
      respondAsync: true,
      waitSeconds: 5,
    });
  });

  it("takes the first occurrence of a repeated preference, also across lines", () => {
    expect(parsePrefer(["wait=5, wait=9"]).waitSeconds).toBe(5);
    expect(parsePrefer(["wait=5", "wait=9"]).waitSeconds).toBe(5);
  });

  it.each(["wait=abc", "wait=-1", "wait=1.5", "wait=", "wait", "wait=1e3", 'wait="7', "wait=+3"])(
    "ignores an invalid wait: %s",
    (value) => {
      expect(parsePrefer([value])).toEqual(none);
    },
  );

  it("lets an invalid first wait win over a later valid one (RFC 7240 §2: only the first counts)", () => {
    expect(parsePrefer(["wait=abc, wait=5"]).waitSeconds).toBeNull();
  });

  it("ignores unknown preferences and malformed elements", () => {
    expect(
      parsePrefer(['return=minimal, handling=lenient, foo="a, wait=3", =x, ,, b@d=1, wait=4']),
    ).toEqual({ respondAsync: false, waitSeconds: 4 });
  });

  it("ignores parameters after ';'", () => {
    expect(parsePrefer(["wait=5; foo=bar; baz, respond-async;x=1"])).toEqual({
      respondAsync: true,
      waitSeconds: 5,
    });
  });

  it("keeps a quoted value containing ',' or ';' in one piece", () => {
    expect(parsePrefer(['foo="a,b;c", wait=6'])).toEqual({ respondAsync: false, waitSeconds: 6 });
    expect(parsePrefer(['foo="a\\"b,c", wait=6']).waitSeconds).toBe(6);
  });

  it("caps an absurdly long wait at a safe integer instead of failing", () => {
    expect(parsePrefer([`wait=${"9".repeat(40)}`]).waitSeconds).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("prefer.effective-wait", () => {
  const cfg = { defaultMs: 30_000, maxMs: 195_000 };

  it("waits the default without a wait preference", () => {
    expect(effectiveWaitMs(none, cfg)).toBe(30_000);
  });

  it("waits what the client asked for, below the maximum", () => {
    expect(effectiveWaitMs({ respondAsync: false, waitSeconds: 2 }, cfg)).toBe(2_000);
    expect(effectiveWaitMs({ respondAsync: false, waitSeconds: 0 }, cfg)).toBe(0);
  });

  it("caps the wait at the maximum", () => {
    expect(effectiveWaitMs({ respondAsync: false, waitSeconds: 600 }, cfg)).toBe(195_000);
    expect(
      effectiveWaitMs({ respondAsync: false, waitSeconds: Number.MAX_SAFE_INTEGER }, cfg),
    ).toBe(195_000);
  });

  it("does not wait at all for respond-async, whatever wait says", () => {
    expect(effectiveWaitMs({ respondAsync: true, waitSeconds: null }, cfg)).toBe(0);
    expect(effectiveWaitMs({ respondAsync: true, waitSeconds: 5 }, cfg)).toBe(0);
  });
});

describe("prefer.applied", () => {
  const cfg = { defaultMs: 30_000, maxMs: 195_000 };

  it("names nothing when no preference was honoured", () => {
    expect(preferenceApplied(none, cfg)).toBeUndefined();
  });

  it("reports the wait used", () => {
    expect(preferenceApplied({ respondAsync: false, waitSeconds: 2 }, cfg)).toBe("wait=2");
    expect(preferenceApplied({ respondAsync: false, waitSeconds: 0 }, cfg)).toBe("wait=0");
  });

  it("reports the cap when the wait was capped, in whole seconds", () => {
    expect(preferenceApplied({ respondAsync: false, waitSeconds: 900 }, cfg)).toBe("wait=195");
    expect(
      preferenceApplied({ respondAsync: false, waitSeconds: 9 }, { defaultMs: 200, maxMs: 1_500 }),
    ).toBe("wait=1");
  });

  it("reports only respond-async when both were sent", () => {
    expect(preferenceApplied({ respondAsync: true, waitSeconds: 5 }, cfg)).toBe("respond-async");
    expect(preferenceApplied({ respondAsync: true, waitSeconds: null }, cfg)).toBe("respond-async");
  });
});
