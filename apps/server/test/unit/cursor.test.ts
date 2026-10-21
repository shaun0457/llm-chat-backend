import { describe, expect, it } from "vitest";

import { decodeCursor, encodeCursor } from "../../src/modules/sessions/cursor.js";

const key = { t: "2026-10-21T15:27:10.982364Z", id: "01a15f12-d0b7-71ce-a2fc-98b3f003221c" };

const base64url = (text: string) => Buffer.from(text).toString("base64url");

describe("session list cursor", () => {
  it("round-trips the ordering key at microsecond precision", () => {
    const cursor = encodeCursor(key);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual(key);
  });

  it("is base64url of a small JSON object", () => {
    expect(JSON.parse(Buffer.from(encodeCursor(key), "base64url").toString())).toEqual(key);
  });

  it.each([
    ["not base64url JSON", "%%%"],
    ["JSON that is not an object", base64url("[1,2]")],
    ["a missing id", base64url(JSON.stringify({ t: key.t }))],
    ["an id that is not a UUID", base64url(JSON.stringify({ ...key, id: "1 OR 1=1" }))],
    [
      "a millisecond timestamp",
      base64url(JSON.stringify({ ...key, t: "2026-10-21T15:27:10.982Z" })),
    ],
    [
      "a timestamp with an offset",
      base64url(JSON.stringify({ ...key, t: "2026-10-21T15:27:10.982364+02:00" })),
    ],
    ["an impossible date", base64url(JSON.stringify({ ...key, t: "2026-02-31T00:00:00.000000Z" }))],
    ["extra fields", base64url(JSON.stringify({ ...key, x: 1 }))],
  ])("rejects %s", (_name, cursor) => {
    expect(decodeCursor(cursor)).toBeUndefined();
  });
});
