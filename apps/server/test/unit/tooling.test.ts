import { describe, expect, it } from "vitest";

describe("test tooling", () => {
  it("runs TypeScript tests through Vitest", () => {
    const answer: number = 42;
    expect(answer).toBe(42);
  });
});
