import { estimateTokens } from "../../llm/estimate.js";
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

/** One completed earlier turn as the model sees it. */
export type HistoryTurn = Readonly<{ question: string; answer: string }>;

/** Estimated framing cost of every message sent, on top of its text. */
export const MESSAGE_OVERHEAD_TOKENS = 8;
/** Share of the context window kept free for estimation error. */
const MARGIN = 0.1;

const messageTokens = (content: string) => estimateTokens(content) + MESSAGE_OVERHEAD_TOKENS;
const turnTokens = (turn: HistoryTurn) => messageTokens(turn.question) + messageTokens(turn.answer);

/**
 * The cheapest possible turn: a question of at least 1 token (message content is never blank:
 * sendMessageBody's `content` rule), an empty answer, and both messages' overhead.
 */
const MIN_TURN_TOKENS = 1 + 2 * MESSAGE_OVERHEAD_TOKENS;

/** How many turns could fit `budget` at most; bounds how much history is read. */
export function maxTurnsWithin(budget: number): number {
  return Math.max(0, Math.floor(budget / MIN_TURN_TOKENS));
}

/**
 * The tokens left for earlier turns once the model's output reservation, a 10 % margin, the
 * system prompt and the new `message` (each with its overhead) are taken from the context
 * window. Negative: the new message cannot fit the model at all (422 input_too_long).
 */
export function historyBudget(input: {
  contextWindow: number;
  maxOutputTokens: number;
  systemPrompt: string | null;
  message: string;
}): number {
  const { contextWindow, maxOutputTokens, systemPrompt } = input;
  const system = systemPrompt !== null && systemPrompt.length > 0 ? messageTokens(systemPrompt) : 0;
  return (
    contextWindow -
    maxOutputTokens -
    Math.ceil(contextWindow * MARGIN) -
    system -
    messageTokens(input.message)
  );
}

/**
 * The newest turns whose estimated tokens fit `budget`, oldest first. Whole turns only, and
 * selection stops at the first turn that does not fit, so the history kept has no gap.
 */
export function selectHistory(
  turns: readonly HistoryTurn[],
  budget: number,
): readonly HistoryTurn[] {
  const kept: HistoryTurn[] = [];
  let left = budget;
  for (const turn of [...turns].reverse()) {
    const cost = turnTokens(turn);
    if (cost > left) {
      break;
    }
    left -= cost;
    kept.push(turn);
  }
  return kept.reverse();
}

/**
 * What the model sees for one turn: the frozen system prompt (if any), then the newest
 * completed turns below the user message's `seq` that fit `historyBudget` (see selectHistory),
 * as user/assistant pairs in order, then the user message. A turn whose answer is generating or
 * failed is left out whole.
 */
export function assembleContext(input: {
  systemPrompt: string | null;
  history: readonly HistoryRow[];
  userMessage: { seq: number; content: string };
  historyBudget: number;
}): LlmMessage[] {
  const { systemPrompt, history, userMessage } = input;
  const earlier = [...history]
    .filter((row) => row.seq < userMessage.seq)
    .sort((a, b) => a.seq - b.seq);
  const users = new Map(
    earlier.filter((row) => row.role === "user").map((row) => [row.id, row] as const),
  );

  const turns: HistoryTurn[] = [];
  for (const row of earlier) {
    if (row.role !== "assistant" || row.status !== "completed" || row.replyToId === null) {
      continue;
    }
    const question = users.get(row.replyToId);
    if (question !== undefined) {
      turns.push({ question: question.content, answer: row.content });
    }
  }

  const context: LlmMessage[] = [];
  if (systemPrompt !== null && systemPrompt.length > 0) {
    context.push({ role: "system", content: systemPrompt });
  }
  for (const turn of selectHistory(turns, input.historyBudget)) {
    context.push({ role: "user", content: turn.question });
    context.push({ role: "assistant", content: turn.answer });
  }
  context.push({ role: "user", content: userMessage.content });
  return context;
}
