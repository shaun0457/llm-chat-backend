import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import { ApiKey } from "../../src/credentials/api-key.js";

const SECRET = "secret-key-not-real-9";

describe("ApiKey", () => {
  it("reveals the key until it is cleared, then null", () => {
    const key = new ApiKey(SECRET);
    expect(key.reveal()).toBe(SECRET);

    key.clear();

    expect(key.reveal()).toBeNull();
  });

  it("holds no key for a keyless call", () => {
    expect(new ApiKey(null).reveal()).toBeNull();
  });

  it("never shows the key when serialised, inspected or stringified", () => {
    const key = new ApiKey(SECRET);
    const job = { assistantId: "a", apiKey: key };

    expect(JSON.stringify(job)).not.toContain(SECRET);
    expect(inspect(job, { depth: 5, showHidden: true })).not.toContain(SECRET);
    expect(String(key)).not.toContain(SECRET);
    expect(`${key}`).not.toContain(SECRET);
    expect(Object.keys(key)).toEqual([]);
  });
});
