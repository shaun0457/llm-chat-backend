import { and, asc, desc, eq, lt, sql } from "drizzle-orm";

import type { Database, Tx } from "../../db/client.js";
import { messages, sessions } from "../../db/schema.js";
import { isoUtc } from "../../db/timestamps.js";
import type { LlmFinishReason, LlmUsage } from "../../llm/port.js";
import type { HistoryRow } from "./context.js";
import type { Message } from "./schemas.js";

type Executor = Database | Tx;

const messageFields = {
  id: messages.id,
  sessionId: messages.sessionId,
  seq: messages.seq,
  role: messages.role,
  content: messages.content,
  status: messages.status,
  replyToId: messages.replyToId,
  attempt: messages.attempt,
  errorCode: messages.errorCode,
  errorDetail: messages.errorDetail,
  provider: messages.provider,
  model: messages.model,
  promptTokens: messages.promptTokens,
  completionTokens: messages.completionTokens,
  finishReason: messages.finishReason,
  latencyMs: messages.latencyMs,
  createdAt: isoUtc(messages.createdAt),
  updatedAt: isoUtc(messages.updatedAt),
};

const selectMessages = (db: Executor) => db.select(messageFields).from(messages);
type MessageRow = Awaited<ReturnType<typeof selectMessages>>[number];

const FINISH_REASONS: ReadonlySet<string> = new Set<LlmFinishReason>(["stop", "length", "other"]);

/** The API representation. `attempt` exists only for assistant rows (stored as 1 on users). */
export function toMessage(row: MessageRow): Message {
  const { promptTokens, completionTokens, finishReason, ...rest } = row;
  return {
    ...rest,
    attempt: row.role === "assistant" ? row.attempt : null,
    usage:
      promptTokens === null || completionTokens === null
        ? null
        : { promptTokens, completionTokens },
    finishReason:
      finishReason !== null && FINISH_REASONS.has(finishReason)
        ? (finishReason as LlmFinishReason)
        : null,
  };
}

export async function hasGeneratingTurn(tx: Tx, sessionId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.status, "generating")))
    .limit(1);
  return row !== undefined;
}

export type NewTurn = {
  sessionId: string;
  userId: string;
  assistantId: string;
  /** The user's seq; the assistant takes the next one. */
  seq: number;
  content: string;
  provider: string;
  model: string;
  systemPrompt: string | null;
};

/** Inserts the user row (completed) and its generating assistant row (attempt 1). */
export async function insertTurn(
  tx: Tx,
  turn: NewTurn,
): Promise<{ userMessage: Message; assistantMessage: Message }> {
  const rows = await tx
    .insert(messages)
    .values([
      {
        id: turn.userId,
        sessionId: turn.sessionId,
        seq: turn.seq,
        role: "user",
        content: turn.content,
        status: "completed",
      },
      {
        id: turn.assistantId,
        sessionId: turn.sessionId,
        seq: turn.seq + 1,
        role: "assistant",
        replyToId: turn.userId,
        status: "generating",
        attempt: 1,
        startedAt: sql`clock_timestamp()`,
        provider: turn.provider,
        model: turn.model,
        systemPrompt: turn.systemPrompt,
      },
    ])
    .returning(messageFields);
  const user = rows.find((row) => row.role === "user");
  const assistant = rows.find((row) => row.role === "assistant");
  if (user === undefined || assistant === undefined) {
    throw new Error("INSERT … RETURNING did not return both messages of the turn");
  }
  return { userMessage: toMessage(user), assistantMessage: toMessage(assistant) };
}

/** Advances the message counter and the activity time; sets `title` only when given. */
export async function recordTurnOnSession(
  tx: Tx,
  sessionId: string,
  changes: { title: string | undefined },
): Promise<void> {
  await tx
    .update(sessions)
    .set({
      nextSeq: sql`${sessions.nextSeq} + 2`,
      lastActivityAt: sql`clock_timestamp()`,
      ...(changes.title === undefined
        ? {}
        : { title: changes.title, updatedAt: sql`clock_timestamp()` }),
    })
    .where(eq(sessions.id, sessionId));
}

/** The fence every generation write carries: this row, this attempt, still generating. */
const fenced = (id: string, attempt: number) =>
  and(eq(messages.id, id), eq(messages.attempt, attempt), eq(messages.status, "generating"));

/** Writes partial content. False when the fence no longer matches (deleted or superseded). */
export async function flushContent(
  db: Executor,
  fence: { id: string; attempt: number },
  content: string,
): Promise<boolean> {
  const rows = await db
    .update(messages)
    .set({ content, updatedAt: sql`clock_timestamp()` })
    .where(fenced(fence.id, fence.attempt))
    .returning({ id: messages.id });
  return rows.length > 0;
}

export type Completion = {
  content: string;
  usage: LlmUsage | null;
  finishReason: LlmFinishReason;
  latencyMs: number;
};

/** Undefined when the fence no longer matches. */
export async function completeAssistant(
  db: Executor,
  fence: { id: string; attempt: number },
  completion: Completion,
): Promise<Message | undefined> {
  const [row] = await db
    .update(messages)
    .set({
      status: "completed",
      content: completion.content,
      promptTokens: completion.usage?.promptTokens ?? null,
      completionTokens: completion.usage?.completionTokens ?? null,
      finishReason: completion.finishReason,
      latencyMs: completion.latencyMs,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(fenced(fence.id, fence.attempt))
    .returning(messageFields);
  return row === undefined ? undefined : toMessage(row);
}

export type Failure = { content: string; errorCode: string; errorDetail: string };

/** Undefined when the fence no longer matches. */
export async function failAssistant(
  db: Executor,
  fence: { id: string; attempt: number },
  failure: Failure,
): Promise<Message | undefined> {
  const [row] = await db
    .update(messages)
    .set({
      status: "failed",
      content: failure.content,
      errorCode: failure.errorCode,
      errorDetail: failure.errorDetail,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(fenced(fence.id, fence.attempt))
    .returning(messageFields);
  return row === undefined ? undefined : toMessage(row);
}

/** Every message of the session below `seq`, ascending: the raw material of a context. */
export async function historyBefore(
  db: Executor,
  sessionId: string,
  seq: number,
): Promise<HistoryRow[]> {
  return db
    .select({
      id: messages.id,
      seq: messages.seq,
      role: messages.role,
      content: messages.content,
      status: messages.status,
      replyToId: messages.replyToId,
    })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), lt(messages.seq, seq)))
    .orderBy(asc(messages.seq));
}

export async function findMessage(
  db: Executor,
  sessionId: string,
  messageId: string,
): Promise<Message | undefined> {
  const [row] = await selectMessages(db).where(
    and(eq(messages.sessionId, sessionId), eq(messages.id, messageId)),
  );
  return row === undefined ? undefined : toMessage(row);
}

/** The user message and the assistant message answering it, by the assistant's id. */
export async function findTurn(
  db: Executor,
  assistantId: string,
): Promise<{ userMessage: Message; assistantMessage: Message } | undefined> {
  const [assistant] = await selectMessages(db).where(eq(messages.id, assistantId));
  if (assistant === undefined || assistant.replyToId === null) {
    return undefined;
  }
  const [user] = await selectMessages(db).where(eq(messages.id, assistant.replyToId));
  return user === undefined
    ? undefined
    : { userMessage: toMessage(user), assistantMessage: toMessage(assistant) };
}

export async function findSeq(
  db: Executor,
  sessionId: string,
  messageId: string,
): Promise<number | undefined> {
  const [row] = await db
    .select({ seq: messages.seq })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.id, messageId)));
  return row?.seq;
}

/**
 * The newest `limit + 1` messages below `beforeSeq` (all when undefined), newest first, served
 * by the (session_id, seq) unique index. The extra row tells the caller an older page exists.
 */
export async function newestMessages(
  db: Executor,
  sessionId: string,
  options: { limit: number; beforeSeq: number | undefined },
): Promise<Message[]> {
  const rows = await selectMessages(db)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        options.beforeSeq === undefined ? undefined : lt(messages.seq, options.beforeSeq),
      ),
    )
    .orderBy(desc(messages.seq))
    .limit(options.limit + 1);
  return rows.map(toMessage);
}

export async function sessionExists(db: Executor, sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return row !== undefined;
}
