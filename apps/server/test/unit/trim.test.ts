import { describe, expect, it } from "vitest";

import {
  type HistoryTurn,
  historyBudget,
  selectHistory,
} from "../../src/modules/messages/context.js";

// Every string below is ASCII, so it estimates at ceil(length / 3) tokens; "x".repeat(3 * n)
// is n tokens. Each sent message also costs 8 tokens of overhead.
const tokens = (n: number) => "x".repeat(3 * n);

/** A turn of exactly `n` tokens including its two messages' overhead (n ≥ 18). */
const turnOf = (n: number, label: string): HistoryTurn => ({
  question: label.padEnd(3, "q") + tokens(n - 16 - 2),
  answer: tokens(1),
});

describe("historyBudget", () => {
  it("is the context window minus output, margin, system prompt, input and their overhead", () => {
    // 1000 − 100 output − 100 margin (10 %) − (10 + 8) system − (20 + 8) input = 754.
    expect(
      historyBudget({
        contextWindow: 1000,
        maxOutputTokens: 100,
        systemPrompt: tokens(10),
        input: tokens(20),
      }),
    ).toBe(754);
  });

  it("charges no system message when there is no system prompt", () => {
    expect(
      historyBudget({
        contextWindow: 1000,
        maxOutputTokens: 100,
        systemPrompt: null,
        input: tokens(20),
      }),
    ).toBe(772);
  });

  it("rounds the 10 % margin up", () => {
    // margin ceil(100.5) = 101: 1005 − 100 − 101 − 28 = 776.
    expect(
      historyBudget({
        contextWindow: 1005,
        maxOutputTokens: 100,
        systemPrompt: null,
        input: tokens(20),
      }),
    ).toBe(776);
  });

  it("is negative when the input alone does not fit the model with its output reservation", () => {
    expect(
      historyBudget({
        contextWindow: 1000,
        maxOutputTokens: 100,
        systemPrompt: null,
        input: tokens(793),
      }),
    ).toBe(-1);
    expect(
      historyBudget({
        contextWindow: 1000,
        maxOutputTokens: 100,
        systemPrompt: null,
        input: tokens(792),
      }),
    ).toBe(0);
  });
});

describe("selectHistory", () => {
  const turns = [turnOf(20, "t1"), turnOf(30, "t2"), turnOf(40, "t3")];

  it("keeps every turn, oldest first, when all fit", () => {
    expect(selectHistory(turns, 90)).toEqual(turns);
  });

  it("drops the oldest whole turns first", () => {
    expect(selectHistory(turns, 89)).toEqual([turns[1], turns[2]]);
    expect(selectHistory(turns, 70)).toEqual([turns[1], turns[2]]);
    expect(selectHistory(turns, 69)).toEqual([turns[2]]);
  });

  it("never splits a turn: one that does not fit whole is left out whole", () => {
    expect(selectHistory(turns, 39)).toEqual([]);
  });

  it("stops at the first turn that does not fit, so the history it keeps has no gap", () => {
    const withBigMiddle = [turnOf(20, "t1"), turnOf(100, "t2"), turnOf(20, "t3")];

    expect(selectHistory(withBigMiddle, 60)).toEqual([withBigMiddle[2]]);
  });

  it("selects nothing for a zero budget or no turns", () => {
    expect(selectHistory(turns, 0)).toEqual([]);
    expect(selectHistory([], 1000)).toEqual([]);
  });
});
