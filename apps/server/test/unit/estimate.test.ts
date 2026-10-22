import { describe, expect, it } from "vitest";

import { estimateTokens } from "../../src/llm/estimate.js";

describe("estimateTokens", () => {
  it("is 0 for the empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it.each([
    ["a", 1],
    ["abc", 1],
    ["abcd", 2],
    ["Hello, world!", 5],
  ])("counts other text as ceil(characters / 3): %j → %i", (text, tokens) => {
    expect(estimateTokens(text)).toBe(tokens);
  });

  it.each([
    ["Han", "你好世界", 4],
    ["Hiragana", "ひらがな", 4],
    ["Katakana", "カタカナ", 4],
    ["Hangul", "안녕하세요", 5],
  ])("counts each %s character as one token", (_script, text, tokens) => {
    expect(estimateTokens(text)).toBe(tokens);
  });

  it("adds the CJK count to ceil(other characters / 3) for mixed text", () => {
    // 2 Han characters; "Hi, " and "!" are 5 other characters → ceil(5 / 3) = 2.
    expect(estimateTokens("Hi, 你好!")).toBe(4);
  });

  it("counts an emoji as one non-CJK character, not as two UTF-16 units", () => {
    expect(estimateTokens("😀😀😀")).toBe(1);
    expect(estimateTokens("😀😀😀😀")).toBe(2);
  });
});
