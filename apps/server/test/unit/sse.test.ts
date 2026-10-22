import { describe, expect, it } from "vitest";

import { PING_FRAME, encodeEvent } from "../../src/http/sse.js";

describe("SSE encoding", () => {
  it("frames an event as an event line, one data line and a blank line", () => {
    expect(encodeEvent("delta", { id: "m1", attempt: 1, text: "Hel" })).toBe(
      'event: delta\ndata: {"id":"m1","attempt":1,"text":"Hel"}\n\n',
    );
  });

  it("keeps text with line breaks on the single data line", () => {
    const frame = encodeEvent("delta", { text: "one\ntwo\r\nthree\rfour" });

    expect(frame).toBe('event: delta\ndata: {"text":"one\\ntwo\\r\\nthree\\rfour"}\n\n');
    // Exactly the two field lines and the blank line that ends the event.
    expect(frame.split(/\r\n|\r|\n/)).toEqual([
      "event: delta",
      'data: {"text":"one\\ntwo\\r\\nthree\\rfour"}',
      "",
      "",
    ]);
  });

  it("writes a ping as a comment line", () => {
    expect(PING_FRAME).toBe(": ping\n\n");
  });
});
