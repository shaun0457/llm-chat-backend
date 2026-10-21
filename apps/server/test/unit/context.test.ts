import { describe, expect, it } from "vitest";

import { type HistoryRow, assembleContext } from "../../src/modules/messages/context.js";

type Status = HistoryRow["status"];

/** A user row at `seq` and its assistant at `seq + 1`. */
function turn(seq: number, status: Status, question: string, answer: string): HistoryRow[] {
  const userId = `u${seq}`;
  return [
    { id: userId, seq, role: "user", content: question, status: "completed", replyToId: null },
    {
      id: `a${seq + 1}`,
      seq: seq + 1,
      role: "assistant",
      content: answer,
      status,
      replyToId: userId,
    },
  ];
}

describe("assembleContext", () => {
  it("is the system prompt, completed turns in seq order, then the new user message", () => {
    const history = [...turn(3, "completed", "Q2", "A2"), ...turn(1, "completed", "Q1", "A1")];

    expect(
      assembleContext({
        systemPrompt: "Be brief.",
        history,
        userMessage: { seq: 5, content: "Q3" },
      }),
    ).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
      { role: "assistant", content: "A2" },
      { role: "user", content: "Q3" },
    ]);
  });

  it("leaves out whole turns whose answer failed or is still generating", () => {
    const history = [
      ...turn(1, "failed", "Q1", "partial"),
      ...turn(3, "completed", "Q2", "A2"),
      ...turn(5, "generating", "Q3", "so far"),
    ];

    expect(
      assembleContext({ systemPrompt: null, history, userMessage: { seq: 7, content: "Q4" } }),
    ).toEqual([
      { role: "user", content: "Q2" },
      { role: "assistant", content: "A2" },
      { role: "user", content: "Q4" },
    ]);
  });

  it("context.seq-cutoff: includes only completed turns below the user message's seq", () => {
    const history = [
      ...turn(1, "completed", "Before", "Answer before"),
      ...turn(5, "completed", "After", "Answer after"),
      ...turn(7, "completed", "Later", "Answer later"),
    ];

    expect(
      assembleContext({ systemPrompt: null, history, userMessage: { seq: 3, content: "Target" } }),
    ).toEqual([
      { role: "user", content: "Before" },
      { role: "assistant", content: "Answer before" },
      { role: "user", content: "Target" },
    ]);
  });

  it("sends no system message for a null or empty system prompt", () => {
    for (const systemPrompt of [null, ""]) {
      expect(
        assembleContext({ systemPrompt, history: [], userMessage: { seq: 1, content: "Hi" } }),
      ).toEqual([{ role: "user", content: "Hi" }]);
    }
  });

  it("ignores a user message without an answer", () => {
    const lonely: HistoryRow = {
      id: "u1",
      seq: 1,
      role: "user",
      content: "Unanswered",
      status: "completed",
      replyToId: null,
    };

    expect(
      assembleContext({
        systemPrompt: null,
        history: [lonely],
        userMessage: { seq: 3, content: "Hi" },
      }),
    ).toEqual([{ role: "user", content: "Hi" }]);
  });
});
