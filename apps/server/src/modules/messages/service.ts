import { performance } from "node:perf_hooks";
import { v7 as uuidv7 } from "uuid";

import type { Db, Tx } from "../../db/client.js";
import { pgConstraint, pgErrorCode } from "../../db/errors.js";
import { ProblemError } from "../../http/problem-details.js";
import type { ModelCatalog } from "../../llm/catalog.js";
import type { LlmProvider } from "../../llm/port.js";
import type { ProviderRegistry } from "../../llm/registry.js";
import { type LockedSession, lockSession } from "../sessions/repository.js";
import { resolvedPair, sessionNotFound } from "../sessions/service.js";
import type { Attach } from "./attach.js";
import type { JobRegistry, Reservation } from "./jobs.js";
import {
  findMessage,
  findSeq,
  hasGeneratingTurn,
  insertTurn,
  newestMessages,
  recordTurnOnSession,
  sessionExists,
} from "./repository.js";
import type { ListMessagesInput, Message, MessagePage, SendMessageInput, Turn } from "./schemas.js";

const UNIQUE_VIOLATION = "23505";
const ONE_GENERATING_INDEX = "messages_one_generating_per_session";
const TITLE_MAX_CODE_POINTS = 60;

export type MessagesService = {
  /**
   * Admits a turn, starts its generation and waits for it. The assistant message's status is
   * the outcome: completed, failed, or still generating (the server is shutting down).
   */
  send(sessionId: string, input: SendMessageInput): Promise<Turn>;
  list(sessionId: string, page: ListMessagesInput): Promise<MessagePage>;
  /** Throws 404 message_not_found unless the message belongs to this session. */
  get(sessionId: string, messageId: string): Promise<Message>;
};

export const sessionBusy = () =>
  new ProblemError(
    409,
    "session_busy",
    "An answer is still being generated in this session; wait for it to finish",
  );

/** Capacity refused: today only because the server is shutting down. */
export const serverBusy = () =>
  new ProblemError(
    503,
    "server_busy",
    "The server cannot start another answer right now; try again later",
    undefined,
    { "retry-after": "10" },
  );

export const messageNotFound = () =>
  new ProblemError(404, "message_not_found", "No message with this id in this session");

/**
 * Title from a session's first message: the first non-blank line, trimmed, whitespace runs
 * collapsed, at most 60 code points including the ellipsis that marks a cut.
 */
export function deriveTitle(content: string): string {
  const line = content.split(/\r\n|\r|\n/).find((candidate) => candidate.trim().length > 0) ?? "";
  const collapsed = line.trim().replace(/\s+/g, " ");
  const codePoints = [...collapsed];
  if (codePoints.length <= TITLE_MAX_CODE_POINTS) {
    return collapsed;
  }
  return `${codePoints
    .slice(0, TITLE_MAX_CODE_POINTS - 1)
    .join("")
    .trimEnd()}…`;
}

/** The turn as admitted, with what the job needs that the response does not show. */
type Admitted = {
  turn: Turn;
  adapter: LlmProvider;
  model: string;
  maxOutputTokens: number;
  systemPrompt: string | null;
  startedAtMonotonic: number;
};

export function createMessagesService(deps: {
  db: Db;
  registry: ProviderRegistry;
  catalog: ModelCatalog;
  jobs: JobRegistry;
  attach: Attach;
  defaultSystemPrompt: string | undefined;
}): MessagesService {
  const { db, registry, catalog, jobs, attach, defaultSystemPrompt } = deps;

  // Admission steps, in the order the spec fixes. Later steps (stale reclaim, replay, budget,
  // credential, expected history, capacity limits) slot in between these.

  async function lockStep(tx: Tx, sessionId: string): Promise<LockedSession> {
    const session = await lockSession(tx, sessionId);
    if (session === undefined) {
      throw sessionNotFound();
    }
    return session;
  }

  function resolveStep(session: LockedSession): {
    adapter: LlmProvider;
    provider: string;
    model: string;
    maxOutputTokens: number;
  } {
    const pair = resolvedPair(registry.resolve({}, session));
    const adapter = registry.adapter(pair.provider);
    if (adapter === undefined) {
      throw new ProblemError(422, "provider_unavailable", "The provider is unknown or not enabled");
    }
    const entry = catalog.find(pair.provider, pair.model);
    if (entry === undefined) {
      throw new ProblemError(
        422,
        "model_not_supported",
        "The model is not in the provider's catalog",
      );
    }
    return {
      adapter,
      provider: pair.provider,
      model: pair.model,
      maxOutputTokens: entry.maxOutputTokens,
    };
  }

  async function busyStep(tx: Tx, sessionId: string): Promise<void> {
    if (await hasGeneratingTurn(tx, sessionId)) {
      throw sessionBusy();
    }
  }

  async function insertStep(
    tx: Tx,
    sessionId: string,
    session: LockedSession,
    content: string,
    resolved: ReturnType<typeof resolveStep>,
  ): Promise<Admitted> {
    const systemPrompt =
      session.systemPrompt ??
      (defaultSystemPrompt !== undefined && defaultSystemPrompt.length > 0
        ? defaultSystemPrompt
        : null);
    const startedAtMonotonic = performance.now();
    const turn = await insertTurn(tx, {
      sessionId,
      userId: uuidv7(),
      assistantId: uuidv7(),
      seq: session.nextSeq,
      content,
      provider: resolved.provider,
      model: resolved.model,
      systemPrompt,
    });
    await recordTurnOnSession(tx, sessionId, {
      title: session.title === null ? deriveTitle(content) : undefined,
    });
    return {
      turn,
      adapter: resolved.adapter,
      model: resolved.model,
      maxOutputTokens: resolved.maxOutputTokens,
      systemPrompt,
      startedAtMonotonic,
    };
  }

  async function admit(
    sessionId: string,
    content: string,
  ): Promise<{ admitted: Admitted; reservation: Reservation }> {
    // Kept outside the callback only so a rollback (or a failed commit) can release it.
    let held: Reservation | undefined;
    try {
      return await db.tx(async (tx) => {
        const session = await lockStep(tx, sessionId);
        const resolved = resolveStep(session);
        await busyStep(tx, sessionId);
        const reservation = jobs.reserve();
        if (reservation === undefined) {
          throw serverBusy();
        }
        held = reservation;
        const admitted = await insertStep(tx, sessionId, session, content, resolved);
        return { admitted, reservation };
      });
    } catch (error) {
      held?.release();
      // The lock makes this a backstop: only a second process could get here.
      if (pgErrorCode(error) === UNIQUE_VIOLATION && pgConstraint(error) === ONE_GENERATING_INDEX) {
        throw sessionBusy();
      }
      throw error;
    }
  }

  return {
    async send(sessionId, input) {
      const { admitted, reservation } = await admit(sessionId, input.content);
      const { userMessage, assistantMessage } = admitted.turn;
      const { attempt } = assistantMessage;
      if (attempt === null) {
        throw new Error("an admitted assistant message has no attempt");
      }
      jobs.start({
        assistantId: assistantMessage.id,
        attempt,
        sessionId,
        userMessage: { seq: userMessage.seq, content: userMessage.content },
        provider: admitted.adapter,
        model: admitted.model,
        maxOutputTokens: admitted.maxOutputTokens,
        systemPrompt: admitted.systemPrompt,
        apiKey: null,
        startedAtMonotonic: admitted.startedAtMonotonic,
        reservation,
      });

      const turn = await attach.json(assistantMessage.id, attempt);
      if (turn === undefined) {
        // Deleted while generating, normally together with its session.
        throw (await sessionExists(db.drizzle, sessionId)) ? messageNotFound() : sessionNotFound();
      }
      return turn;
    },

    async list(sessionId, { limit, before }) {
      if (!(await sessionExists(db.drizzle, sessionId))) {
        throw sessionNotFound();
      }
      let beforeSeq: number | undefined;
      if (before !== undefined) {
        beforeSeq = await findSeq(db.drizzle, sessionId, before);
        if (beforeSeq === undefined) {
          throw messageNotFound();
        }
      }
      const newestFirst = await newestMessages(db.drizzle, sessionId, { limit, beforeSeq });
      const items = newestFirst.slice(0, limit).reverse();
      const oldest = items[0];
      return {
        items,
        nextBefore: newestFirst.length > limit && oldest !== undefined ? oldest.id : null,
      };
    },

    async get(sessionId, messageId) {
      const message = await findMessage(db.drizzle, sessionId, messageId);
      if (message === undefined) {
        throw messageNotFound();
      }
      return message;
    },
  };
}
