import type { LlmMessage } from "../../llm/port.js";

/** The columns context assembly reads from a session's earlier messages. */
export type HistoryRow = {
  id: string;
  seq: number;
  role: "user" | "assistant";
  content: string;
  status: "generating" | "completed" | "failed";
  replyToId: string | null;
};

/**
 * What the model sees for one turn: the frozen system prompt (if any), then every completed
 * turn below the user message's `seq` as user/assistant pairs in order, then the user message.
 * A turn whose answer is generating or failed is left out whole. No trimming yet.
 */
export function assembleContext(input: {
  systemPrompt: string | null;
  history: readonly HistoryRow[];
  userMessage: { seq: number; content: string };
}): LlmMessage[] {
  const { systemPrompt, history, userMessage } = input;
  const earlier = [...history]
    .filter((row) => row.seq < userMessage.seq)
    .sort((a, b) => a.seq - b.seq);
  const users = new Map(
    earlier.filter((row) => row.role === "user").map((row) => [row.id, row] as const),
  );

  const context: LlmMessage[] = [];
  if (systemPrompt !== null && systemPrompt.length > 0) {
    context.push({ role: "system", content: systemPrompt });
  }
  for (const row of earlier) {
    if (row.role !== "assistant" || row.status !== "completed" || row.replyToId === null) {
      continue;
    }
    const question = users.get(row.replyToId);
    if (question !== undefined) {
      context.push({ role: "user", content: question.content });
      context.push({ role: "assistant", content: row.content });
    }
  }
  context.push({ role: "user", content: userMessage.content });
  return context;
}
