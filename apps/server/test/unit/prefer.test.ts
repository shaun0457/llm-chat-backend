import { describe, expect, it } from "vitest";

import { parsePrefer } from "../../src/modules/messages/prefer.js";

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
