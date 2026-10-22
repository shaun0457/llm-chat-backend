import { describe, expect, it } from "vitest";

import { scrub } from "../../src/credentials/scrub.js";

const KEY = "fake-key-Zq81.x+y";

describe("scrub", () => {
  it("removes the literal key wherever it appears, also twice", () => {
    expect(scrub(`key ${KEY} rejected; you sent ${KEY}.`, KEY)).toBe(
      "key [REDACTED] rejected; you sent [REDACTED].",
    );
  });

  it("removes a key containing regular expression characters literally", () => {
    expect(scrub("a.b*c(d) and a-b-c-d", "a.b*c(d)")).toBe("[REDACTED] and a-b-c-d");
  });

  it.each([
    ["Authorization: Bearer abc.def-ghi_123", "Authorization: Bearer [REDACTED]"],
    ["bearer   tok/en+=", "bearer [REDACTED]"],
    ['{"auth":"Bearer abcDEF123"}', '{"auth":"Bearer [REDACTED]"}'],
  ])("removes bearer tokens without knowing the key: %s", (input, expected) => {
    expect(scrub(input, null)).toBe(expected);
  });

  it.each([
    ["GET /v1/x?api_key=abc123&model=m", "GET /v1/x?api_key=[REDACTED]&model=m"],
    ["https://h/p?key=abc123", "https://h/p?key=[REDACTED]"],
    ["https://h/p?model=m&apikey=abc", "https://h/p?model=m&apikey=[REDACTED]"],
    ["url: x?api-key=abc;y", "url: x?api-key=[REDACTED];y"],
  ])("removes key query values: %s", (input, expected) => {
    expect(scrub(input, null)).toBe(expected);
  });

  it("keeps the ordinary word that follows 'bearer' in prose", () => {
    expect(scrub("Missing bearer token in the Authorization header", null)).toBe(
      "Missing bearer token in the Authorization header",
    );
  });

  it("keeps ordinary words that only contain 'key'", () => {
    expect(scrub("monkey=1 and the keyboard", null)).toBe("monkey=1 and the keyboard");
  });

  it("removes well-known key formats without knowing the key", () => {
    expect(scrub("got nvapi-EXAMPLE000000_xyz and sk-proj-EXAMPLE0000000000000", null)).toBe(
      "got [REDACTED] and [REDACTED]",
    );
  });

  it("removes partially masked keys an upstream echoes back", () => {
    expect(scrub("Incorrect API key provided: sk-proj-********abcd.", null)).toBe(
      "Incorrect API key provided: [REDACTED].",
    );
    expect(scrub("key nvapi-****wxyz is invalid", null)).toBe("key [REDACTED] is invalid");
  });

  it("leaves text without credentials unchanged, with or without a key", () => {
    expect(scrub("The model is overloaded.", null)).toBe("The model is overloaded.");
    expect(scrub("The model is overloaded.", KEY)).toBe("The model is overloaded.");
  });

  it("removes the key as a JSON body or a URL would echo it", () => {
    const key = 'k"ey\\with/sp&ce';

    expect(scrub(JSON.stringify({ message: `bad key ${key}` }), key)).toBe(
      '{"message":"bad key [REDACTED]"}',
    );
    expect(scrub(`https://h/p?token=${encodeURIComponent(key)}`, key)).toBe(
      "https://h/p?token=[REDACTED]",
    );
  });

  it("removes the key before the patterns, so no fragment of it survives", () => {
    expect(scrub(`Bearer ${KEY}`, KEY)).toBe("Bearer [REDACTED]");
    expect(scrub(`?api_key=${KEY}`, KEY)).toBe("?api_key=[REDACTED]");
  });
});
