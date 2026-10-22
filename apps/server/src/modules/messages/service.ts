import { v7 as uuidv7 } from "uuid";

import type { Clock } from "../../clock.js";
import { ApiKey } from "../../credentials/api-key.js";
import { type OperatorKeys, decideCredential } from "../../credentials/decide.js";
import type { Db, Tx } from "../../db/client.js";
import { pgConstraint, pgErrorCode } from "../../db/errors.js";
import { ProblemError } from "../../http/problem-details.js";
import type { LlmProvider } from "../../llm/port.js";
import type { ProviderRegistry } from "../../llm/registry.js";
import { type LockedSession, lockSession } from "../sessions/repository.js";
import { resolvedPair, sessionNotFound } from "../sessions/service.js";
import type { Attach, JsonOutcome } from "./attach.js";
import { historyBudget } from "./context.js";
import type { JobRegistry, Reservation } from "./jobs.js";
import { reclaimStale } from "./reclaim.js";
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
   * Admits a turn, starts its generation and waits for it at most `waitMs`: completed, failed,
   * or pending when the answer is still being generated (also when the server shuts down).
   */
  send(
    sessionId: string,
    input: SendMessageInput,
    options: { waitMs: number; apiKey: string | undefined },
  ): Promise<JsonOutcome>;
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

/** Capacity refused: the process is at its limit, or the server is shutting down. */
export const serverBusy = () =>
  new ProblemError(
    503,
    "server_busy",
    "The server cannot start another answer right now; try again later",
    undefined,
    { "retry-after": "10" },
  );

/** The turn's provider is at its limit; other providers may still have room. */
export const providerBusy = (provider: string, limit: number) =>
  new ProblemError(
    503,
    "provider_busy",
    `The provider "${provider}" is at its limit of ${limit} active ${limit === 1 ? "answer" : "answers"}; try again later`,
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
  historyBudget: number;
  startedAtMonotonic: number;
  apiKey: ApiKey;
};

export function createMessagesService(deps: {
  db: Db;
  registry: ProviderRegistry;
  jobs: JobRegistry;
  attach: Attach;
  defaultSystemPrompt: string | undefined;
  clock: Clock;
  /** A generating row older than this has no live job; see reclaimStale. */
  staleThresholdMs: number;
  /** Secrets: the server's own key per provider id. */
  operatorKeys: OperatorKeys;
}): MessagesService {
  const { db, registry, jobs, attach, defaultSystemPrompt, clock, staleThresholdMs, operatorKeys } =
    deps;

  // Admission steps, in the order the spec fixes: lock, reclaim, resolve, budget, credential,
  // busy, capacity, insert. Replay (#10) and the expected-history check (#23) slot in later.

  async function lockStep(tx: Tx, sessionId: string): Promise<LockedSession> {
    const session = await lockSession(tx, sessionId);
    if (session === undefined) {
      throw sessionNotFound();
    }
    return session;
  }

  /** A turn left generating by a crash or a failed final write no longer blocks the session. */
  async function reclaimStep(tx: Tx, sessionId: string): Promise<void> {
    await reclaimStale(tx, sessionId, staleThresholdMs);
  }

  /**
   * The turn's provider and model: the request's override resolved against the locked
   * session's defaults by the same rule as session create and update. The session keeps its own.
   */
  function resolveStep(
    session: LockedSession,
    requested: { provider?: string; model?: string },
  ): {
    adapter: LlmProvider;
    provider: string;
    requiresKey: boolean;
    model: string;
    contextWindow: number;
    maxOutputTokens: number;
  } {
    const pair = resolvedPair(registry.resolve(requested, session));
    const provider = registry.provider(pair.provider);
    const adapter = registry.adapter(pair.provider);
    if (provider === undefined || adapter === undefined) {
      throw new ProblemError(422, "provider_unavailable", "The provider is unknown or not enabled");
    }
    const entry = provider.models.find((candidate) => candidate.id === pair.model);
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
      requiresKey: provider.requiresKey,
      model: pair.model,
      contextWindow: entry.contextWindow,
      maxOutputTokens: entry.maxOutputTokens,
    };
  }

  /** The frozen system prompt of a new turn: the session's own, else the server's default. */
  function systemPromptOf(session: LockedSession): string | null {
    return (
      session.systemPrompt ??
      (defaultSystemPrompt !== undefined && defaultSystemPrompt.length > 0
        ? defaultSystemPrompt
        : null)
    );
  }

  /** Tokens left for earlier turns; throws 422 input_too_long when the input cannot fit. */
  function budgetStep(
    resolved: ReturnType<typeof resolveStep>,
    systemPrompt: string | null,
    content: string,
  ): number {
    const budget = historyBudget({
      contextWindow: resolved.contextWindow,
      maxOutputTokens: resolved.maxOutputTokens,
      systemPrompt,
      message: content,
    });
    if (budget < 0) {
      throw new ProblemError(
        422,
        "input_too_long",
        "The message is too long for the model's context window",
      );
    }
    return budget;
  }

  /** Decided once per new turn; the key goes only into the job. */
  function credentialStep(
    resolved: ReturnType<typeof resolveStep>,
    headerKey: string | undefined,
  ): ApiKey {
    const decision = decideCredential(
      headerKey,
      { id: resolved.provider, requiresKey: resolved.requiresKey },
      operatorKeys,
    );
    if ("rejected" in decision) {
      throw new ProblemError(
        422,
        "llm_credential_missing",
        "This provider needs an API key: send one in the X-LLM-Api-Key header",
      );
    }
    return new ApiKey(decision.key);
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
    systemPrompt: string | null,
    budget: number,
    apiKey: ApiKey,
  ): Promise<Admitted> {
    // Immediately before the insert that sets started_at: the deadline then never ends later
    // than started_at + deadline, without comparing this clock with the database's.
    const startedAtMonotonic = clock.monotonicNow();
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
      historyBudget: budget,
      startedAtMonotonic,
      apiKey,
    };
  }

  /** Synchronous, right before the insert; 503 with Retry-After when there is no room. */
  function capacityStep(provider: string): Reservation {
    const reservation = jobs.reserve(provider);
    if (!("rejected" in reservation)) {
      return reservation;
    }
    throw reservation.rejected === "provider_busy"
      ? providerBusy(provider, reservation.limit)
      : serverBusy();
  }

  async function admit(
    sessionId: string,
    input: SendMessageInput,
    headerKey: string | undefined,
  ): Promise<{ admitted: Admitted; attempt: number; reservation: Reservation }> {
    // Kept outside the callback only so a rollback (or a failed commit) can release it.
    let held: Reservation | undefined;
    try {
      return await db.tx(async (tx) => {
        const session = await lockStep(tx, sessionId);
        await reclaimStep(tx, sessionId);
        const { content } = input;
        const resolved = resolveStep(session, input);
        const systemPrompt = systemPromptOf(session);
        const budget = budgetStep(resolved, systemPrompt, content);
        const apiKey = credentialStep(resolved, headerKey);
        await busyStep(tx, sessionId);
        const reservation = capacityStep(resolved.provider);
        held = reservation;
        const admitted = await insertStep(
          tx,
          sessionId,
          session,
          content,
          resolved,
          systemPrompt,
          budget,
          apiKey,
        );
        const { attempt } = admitted.turn.assistantMessage;
        if (attempt === null) {
          // Thrown inside the transaction, so the turn is rolled back instead of left generating.
          throw new Error("an admitted assistant message has no attempt");
        }
        return { admitted, attempt, reservation };
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
    async send(sessionId, input, { waitMs, apiKey }) {
      const { admitted, attempt, reservation } = await admit(sessionId, input, apiKey);
      const { userMessage, assistantMessage } = admitted.turn;
      jobs.start({
        assistantId: assistantMessage.id,
        attempt,
        sessionId,
        userMessage: { seq: userMessage.seq, content: userMessage.content },
        provider: admitted.adapter,
        model: admitted.model,
        maxOutputTokens: admitted.maxOutputTokens,
        systemPrompt: admitted.systemPrompt,
        historyBudget: admitted.historyBudget,
        apiKey: admitted.apiKey,
        startedAtMonotonic: admitted.startedAtMonotonic,
        reservation,
      });

      const outcome = await attach.json(assistantMessage.id, attempt, waitMs);
      if (outcome === undefined) {
        // Deleted while generating, normally together with its session.
        throw (await sessionExists(db.drizzle, sessionId)) ? messageNotFound() : sessionNotFound();
      }
      return outcome;
    },

    async list(sessionId, { limit, before }) {
      await reclaimStale(db.drizzle, sessionId, staleThresholdMs);
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
      await reclaimStale(db.drizzle, sessionId, staleThresholdMs);
      const message = await findMessage(db.drizzle, sessionId, messageId);
      if (message === undefined) {
        throw messageNotFound();
      }
      return message;
    },
  };
}
