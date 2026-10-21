import { v7 as uuidv7 } from "uuid";

import type { Db } from "../../db/client.js";
import { ProblemError } from "../../http/problem-details.js";
import type { ModelPair, PairResolution, ProviderRegistry } from "../../llm/registry.js";
import { type SessionCursor, encodeCursor } from "./cursor.js";
import {
  type SessionChanges,
  deleteSessionRow,
  findSession,
  insertSession,
  listSessionsPage,
  lockSession,
  updateSession,
} from "./repository.js";
import type { CreateSessionInput, Session, SessionPage, UpdateSessionInput } from "./schemas.js";

export type SessionsService = {
  createSession(input: CreateSessionInput): Promise<Session>;
  /** Throws 404 session_not_found. */
  getSession(id: string): Promise<Session>;
  /** Under the row lock; a provider/model change is resolved against the current pair. */
  updateSession(id: string, input: UpdateSessionInput): Promise<Session>;
  /**
   * The only way a session is deleted: lock the row, then delete it. The retention job and
   * aborting a running generation extend this function rather than adding another path.
   */
  deleteSession(id: string): Promise<"deleted" | "not_found">;
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
}): SessionsService {
  const { db, registry } = deps;

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

    async deleteSession(id) {
      return db.tx(async (tx) => {
        if ((await lockSession(tx, id)) === undefined) {
          return "not_found" as const;
        }
        await deleteSessionRow(tx, id);
        return "deleted" as const;
      });
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
