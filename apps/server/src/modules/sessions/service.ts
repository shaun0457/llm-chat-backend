import { v7 as uuidv7 } from "uuid";

import type { Db } from "../../db/client.js";
import { ProblemError } from "../../http/problem-details.js";
import type { ModelPair, PairResolution, ProviderRegistry } from "../../llm/registry.js";
import type { JobRegistry } from "../messages/jobs.js";
import { withTimeout } from "../messages/race.js";
import { reclaimStale } from "../messages/reclaim.js";
import { type SessionCursor, encodeCursor } from "./cursor.js";
import {
  type SessionChanges,
  deleteSessionRow,
  findSession,
  insertSession,
  listSessionsPage,
  lockSession,
  lockSessionActiveSince,
  updateSession,
} from "./repository.js";
import type { CreateSessionInput, Session, SessionPage, UpdateSessionInput } from "./schemas.js";

/**
 * How long a delete waits for the generations it aborted to end and free their capacity. An
 * aborted job stops at once (a provider that ignores the signal is not waited for), so this
 * only bounds a flush still in flight.
 */
const JOB_END_WAIT_MS = 1_000;

export type SessionsService = {
  createSession(input: CreateSessionInput): Promise<Session>;
  /** Throws 404 session_not_found. */
  getSession(id: string): Promise<Session>;
  /** Under the row lock; a provider/model change is resolved against the current pair. */
  updateSession(id: string, input: UpdateSessionInput): Promise<Session>;
  /**
   * The only way a session is deleted, by the endpoint and by retention: under the row lock,
   * stale reclaim, then (with `inactiveBefore`) `skipped` when the session was active at or
   * after that time, then the session is deleted with its messages; once that has committed,
   * every local job of the session is aborted (reason `deleted`). Resolves once those jobs
   * have ended (waiting a moment at most), so their capacity is free again.
   */
  deleteSession(
    id: string,
    options?: { inactiveBefore?: string },
  ): Promise<"deleted" | "not_found" | "skipped">;
  /** A live list: no snapshot, so activity between pages can move a session to page one. */
  listSessions(page: { limit: number; cursor: SessionCursor | undefined }): Promise<SessionPage>;
};

export const sessionNotFound = () =>
  new ProblemError(404, "session_not_found", "No session with this id");

/** The resolved pair, or the 422 problem a client gets when it does not resolve. */
export function resolvedPair(resolution: PairResolution): ModelPair {
  if (resolution.ok) {
    return resolution.pair;
  }
  throw resolution.reason === "provider_unavailable"
    ? new ProblemError(422, "provider_unavailable", "The provider is unknown or not enabled")
    : new ProblemError(422, "model_not_supported", "The model is not in the provider's catalog");
}

export function createSessionsService(deps: {
  db: Db;
  registry: ProviderRegistry;
  /** Session-scoped reads and writes reclaim stale turns first; see reclaimStale. */
  staleThresholdMs: number;
  /** A deleted session's running generations are stopped through it. */
  jobs: Pick<JobRegistry, "abortSession">;
}): SessionsService {
  const { db, registry, staleThresholdMs, jobs } = deps;

  return {
    async createSession(input) {
      const { provider, model } = resolvedPair(registry.resolve(input, registry.defaults));
      return insertSession(db.drizzle, {
        id: uuidv7(),
        title: input.title ?? null,
        provider,
        model,
        systemPrompt: input.systemPrompt ?? null,
      });
    },

    async getSession(id) {
      await reclaimStale(db.drizzle, id, staleThresholdMs);
      const session = await findSession(db.drizzle, id);
      if (session === undefined) {
        throw sessionNotFound();
      }
      return session;
    },

    async updateSession(id, input) {
      return db.tx(async (tx) => {
        const current = await lockSession(tx, id);
        if (current === undefined) {
          throw sessionNotFound();
        }
        await reclaimStale(tx, id, staleThresholdMs);
        const changes: SessionChanges = {};
        if (input.title !== undefined) {
          changes.title = input.title;
        }
        if (input.systemPrompt !== undefined) {
          changes.systemPrompt = input.systemPrompt;
        }
        if (input.provider !== undefined || input.model !== undefined) {
          const { provider, model } = resolvedPair(registry.resolve(input, current));
          changes.provider = provider;
          changes.model = model;
        }
        const updated = await updateSession(tx, id, changes);
        if (updated === undefined) {
          throw new Error("a locked session disappeared during its update");
        }
        return updated;
      });
    },

    async deleteSession(id, options = {}) {
      const { inactiveBefore } = options;
      const outcome = await db.tx(async (tx) => {
        const locked =
          inactiveBefore === undefined
            ? await lockSession(tx, id)
            : await lockSessionActiveSince(tx, id, inactiveBefore);
        if (locked === undefined) {
          return "not_found" as const;
        }
        await reclaimStale(tx, id, staleThresholdMs);
        if ("active" in locked && locked.active) {
          return "skipped" as const;
        }
        await deleteSessionRow(tx, id);
        return "deleted" as const;
      });
      if (outcome !== "deleted") {
        return outcome;
      }
      // After the commit, so that a stream or JSON wait following an aborted job reads the
      // turn as gone (and ends without a final event) rather than as still generating. Until
      // then a job's writes match no row once the delete commits, and are fenced off. By
      // session, whatever the rows said after reclaim: a job whose row was just failed as
      // interrupted may still be running here. A send's job is registered synchronously once
      // its admission commits, before this delete could lock the session, so none is missed.
      const aborted = jobs.abortSession(id, "deleted");
      if (aborted.length > 0) {
        await withTimeout(Promise.all(aborted.map((job) => job.finished)), JOB_END_WAIT_MS);
      }
      return outcome;
    },

    async listSessions({ limit, cursor }) {
      const rows = await listSessionsPage(db.drizzle, { limit, after: cursor });
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeCursor({ t: last.lastActivityAt, id: last.id })
            : null,
      };
    },
  };
}
