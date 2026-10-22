import { v7 as uuidv7 } from "uuid";

import type { Clock } from "../../clock.js";
import { ApiKey } from "../../credentials/api-key.js";
import { type OperatorKeys, decideCredential } from "../../credentials/decide.js";
import type { Db, Tx } from "../../db/client.js";
import { pgConstraint, pgErrorCode } from "../../db/errors.js";
import { ProblemError } from "../../http/problem-details.js";
import type { SseStream } from "../../http/sse.js";
import type { LlmProvider } from "../../llm/port.js";
import type { ProviderRegistry } from "../../llm/registry.js";
import { type LockedSession, lockSession } from "../sessions/repository.js";
import { resolvedPair, sessionNotFound } from "../sessions/service.js";
import type { Attach, JsonOutcome } from "./attach.js";
import { historyBudget } from "./context.js";
import type { JobRegistry, Reservation } from "./jobs.js";
import { reclaimStale } from "./reclaim.js";
import {
  findAnswer,
  findAnyMessage,
  findMessage,
  findSeq,
  findTurn,
  hasGeneratingTurn,
  insertTurn,
  newestMessages,
  recordTurnOnSession,
  sessionExists,
} from "./repository.js";
import type { ListMessagesInput, Message, MessagePage, SendMessageInput, Turn } from "./schemas.js";

const UNIQUE_VIOLATION = "23505";
const ONE_GENERATING_INDEX = "messages_one_generating_per_session";
/**
 * The constraints a client id taken by a concurrent send violates: the user row's primary key,
 * or the assistant row's reply_to_id, whichever row of the turn's insert is checked first.
 */
const CLIENT_ID_CONSTRAINTS: ReadonlySet<string> = new Set([
  "messages_pkey",
  "messages_reply_to_id_unique",
]);
/** Re-runs after a message id collision; the first re-run already resolves it. */
const MAX_ADMISSION_RERUNS = 2;
const TITLE_MAX_CODE_POINTS = 60;

export type MessagesService = {
  /**
   * Admits a turn, starts its generation and waits for it at most `waitMs`, or until
   * `clientGone` aborts: completed, failed, or pending when the answer is still being
   * generated (also when the server shuts down).
   */
  send(
    sessionId: string,
    input: SendMessageInput,
    options: { waitMs: number; apiKey: string | undefined; clientGone?: AbortSignal },
  ): Promise<JsonOutcome>;
  /**
   * Admits a turn like `send`, then opens the event stream with `open` (only once admission
   * succeeded, so a refusal is still an ordinary problem response) and streams the turn.
   */
  sendStreaming(
    sessionId: string,
    input: SendMessageInput,
    options: { apiKey: string | undefined },
    open: () => SseStream,
  ): Promise<void>;
  /**
   * Re-attaches to an assistant message's current attempt: 404 session_not_found or
   * message_not_found (also for a user message) before `open` is called, then the stream.
   */
  events(sessionId: string, messageId: string, open: () => SseStream): Promise<void>;
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

/** A client id already used by a message that this request cannot be a repeat of. */
export const messageIdConflict = (detail: string): ProblemError =>
  new ProblemError(422, "message_id_conflict", detail);

/** The attempt of a turn's assistant message, which every assistant row has. */
function attemptOf(turn: Turn): number {
  const { attempt } = turn.assistantMessage;
  if (attempt === null) {
    throw new Error("an assistant message has no attempt");
  }
  return attempt;
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

/** What admission decided: a new turn to generate, or the stored turn a repeated send names. */
type Admission =
  | { kind: "new"; admitted: Admitted; attempt: number; reservation: Reservation }
  | { kind: "replay"; turn: Turn; attempt: number };

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

  // Admission steps, in the order the spec fixes: lock, reclaim, replay, resolve, budget,
  // credential, busy, capacity, insert. The expected-history check (#23) slots in later.

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
   * The stored turn when the request repeats an earlier send (the same client id, in this
   * session, with identical content and, where the request names them, the provider and model
   * the turn was generated with); undefined when the id is new or absent. Any other use of an
   * existing id is 422 message_id_conflict, whose detail never shows the stored message.
   */
  async function replayStep(
    tx: Tx,
    sessionId: string,
    input: SendMessageInput,
  ): Promise<Turn | undefined> {
    if (input.id === undefined) {
      return undefined;
    }
    const stored = await findAnyMessage(tx, input.id);
    if (stored === undefined) {
      return undefined;
    }
    if (stored.sessionId !== sessionId) {
      throw messageIdConflict("The id is already used by a message in another session");
    }
    if (stored.role !== "user") {
      throw messageIdConflict("The id is already used by an assistant message");
    }
    if (stored.content !== input.content) {
      throw messageIdConflict("The content differs from the stored message with this id");
    }
    const answer = await findAnswer(tx, stored.id);
    if (answer === undefined) {
      throw new Error("a stored user message has no assistant message");
    }
    if (input.provider !== undefined && input.provider !== answer.provider) {
      throw messageIdConflict("The provider differs from the one the stored turn used");
    }
    if (input.model !== undefined && input.model !== answer.model) {
      throw messageIdConflict("The model differs from the one the stored turn used");
    }
    return { userMessage: stored, assistantMessage: answer };
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
        "The message and the system prompt do not fit the model's context window with its output reservation",
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
    userId: string,
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
      userId,
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
    switch (reservation.rejected) {
      case "provider_busy":
        throw providerBusy(provider, reservation.limit);
      case "server_busy":
      case "shutting_down":
        throw serverBusy();
      default: {
        const unhandled: never = reservation;
        throw new Error(`unhandled reservation refusal: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  /** One run of the admission transaction. */
  async function admitOnce(
    sessionId: string,
    input: SendMessageInput,
    headerKey: string | undefined,
  ): Promise<Admission> {
    // Kept outside the callback only so a rollback (or a failed commit) can release it.
    let held: Reservation | undefined;
    try {
      return await db.tx(async (tx): Promise<Admission> => {
        const session = await lockStep(tx, sessionId);
        await reclaimStep(tx, sessionId);
        const replayed = await replayStep(tx, sessionId, input);
        if (replayed !== undefined) {
          // Nothing else applies to a repeated send: no key, catalog, budget, busy or capacity
          // check, and no write. The commit keeps what reclaim may have changed.
          return { kind: "replay", turn: replayed, attempt: attemptOf(replayed) };
        }
        const { content } = input;
        const resolved = resolveStep(session, { provider: input.provider, model: input.model });
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
          input.id ?? uuidv7(),
          content,
          resolved,
          systemPrompt,
          budget,
          apiKey,
        );
        // Thrown inside the transaction, so the turn is rolled back instead of left generating.
        const attempt = attemptOf(admitted.turn);
        return { kind: "new", admitted, attempt, reservation };
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

  /**
   * Admission, re-run when the client's id was inserted by a concurrent send to another
   * session: the session lock does not serialise those, so the insert hits the primary key
   * (or reply_to_id).
   * The next run sees the committed row and answers 422 message_id_conflict (or a replay).
   */
  async function admit(
    sessionId: string,
    input: SendMessageInput,
    headerKey: string | undefined,
  ): Promise<Admission> {
    let collision: unknown;
    for (let run = 0; run <= MAX_ADMISSION_RERUNS; run += 1) {
      try {
        return await admitOnce(sessionId, input, headerKey);
      } catch (error) {
        const clientIdTaken =
          input.id !== undefined &&
          pgErrorCode(error) === UNIQUE_VIOLATION &&
          CLIENT_ID_CONSTRAINTS.has(pgConstraint(error) ?? "");
        if (!clientIdTaken) {
          throw error;
        }
        collision = error;
      }
    }
    // Unexpected: logged by the error handler and answered as 500 internal_error.
    throw new Error("admission kept colliding on a message id", { cause: collision });
  }

  /**
   * Admits a new turn and starts its job, or finds the turn a repeated send refers to; returns
   * the turn as admitted or as stored, and the attempt to attach to.
   */
  async function start(
    sessionId: string,
    input: SendMessageInput,
    apiKey: string | undefined,
  ): Promise<{ turn: Turn; attempt: number }> {
    const admission = await admit(sessionId, input, apiKey);
    if (admission.kind === "replay") {
      return { turn: admission.turn, attempt: admission.attempt };
    }
    const { admitted, attempt, reservation } = admission;
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
    return { turn: admitted.turn, attempt };
  }

  return {
    async send(sessionId, input, { waitMs, apiKey, clientGone }) {
      const { turn, attempt } = await start(sessionId, input, apiKey);
      const { assistantMessage } = turn;
      const outcome = await attach.json(assistantMessage.id, attempt, waitMs, clientGone);
      if (outcome === undefined) {
        // Deleted while generating, normally together with its session.
        throw (await sessionExists(db.drizzle, sessionId)) ? messageNotFound() : sessionNotFound();
      }
      return outcome;
    },

    async sendStreaming(sessionId, input, { apiKey }, open) {
      const { turn, attempt } = await start(sessionId, input, apiKey);
      await attach.sse(open(), turn.assistantMessage.id, attempt, turn);
    },

    async events(sessionId, messageId, open) {
      // Stale reclaim first: a dead generating row is then reported as failed, not detached.
      await reclaimStale(db.drizzle, sessionId, staleThresholdMs);
      if (!(await sessionExists(db.drizzle, sessionId))) {
        throw sessionNotFound();
      }
      // Undefined for a user message too: only assistant messages reply to another.
      const turn = await findTurn(db.drizzle, messageId);
      if (turn === undefined || turn.assistantMessage.sessionId !== sessionId) {
        throw messageNotFound();
      }
      const { attempt } = turn.assistantMessage;
      if (attempt === null) {
        throw messageNotFound();
      }
      await attach.sse(open(), messageId, attempt, turn);
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
