import { describe, expect, it } from "vitest";

import { prefersEventStream } from "../../src/http/accept.js";

describe("prefersEventStream", () => {
  it.each([
    ["text/event-stream"],
    ["TEXT/Event-Stream"],
    ["text/event-stream;charset=utf-8"],
    ["text/event-stream, application/json;q=0.9"],
    ["application/json;q=0.5, text/event-stream;q=0.6"],
    ["text/event-stream, */*;q=0.1"],
    ["text/event-stream, application/*;q=0.5"],
    // The most specific range decides JSON's q: application/json;q=0.2 overrides */*.
    ["text/event-stream;q=0.5, application/json;q=0.2, */*"],
    ["text/html, text/event-stream"],
  ])("streams for %j: the event stream has the highest q", (accept) => {
    expect(prefersEventStream(accept)).toBe(true);
  });

  it.each([
    [undefined],
    [""],
    ["   "],
    ["application/json"],
    ["application/json, text/event-stream;q=0.5"],
    // A tie, here through the wildcard, answers JSON.
    ["text/event-stream, */*"],
    ["text/event-stream, application/*"],
    ["text/event-stream;q=0.5, application/json;q=0.5"],
    ["text/event-stream;q=0"],
    ["text/event-stream;q=0, application/json;q=0"],
    // Ranges that match the event stream only by wildcard never select it.
    ["text/*"],
    ["*/*"],
    ["text/*, application/json;q=0.1"],
    // A malformed q is ignored together with its range.
    ["text/event-stream;q=abc"],
    ["text/event-stream;q=2"],
    ["text/html"],
  ])("answers JSON for %j", (accept) => {
    expect(prefersEventStream(accept)).toBe(false);
  });
});
