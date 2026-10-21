import { type SQL, desc, eq, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import type { Database, Tx } from "../../db/client.js";
import { sessions } from "../../db/schema.js";
import type { ModelPair } from "../../llm/registry.js";
import type { SessionCursor } from "./cursor.js";
import type { Session } from "./schemas.js";

type Executor = Database | Tx;

/** ISO 8601 UTC at the database's microsecond precision; a JS Date would keep milliseconds. */
const isoUtc = (column: PgColumn): SQL<string> =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const sessionFields = {
  id: sessions.id,
  title: sessions.title,
  provider: sessions.provider,
  model: sessions.model,
  systemPrompt: sessions.systemPrompt,
  lastActivityAt: isoUtc(sessions.lastActivityAt),
  createdAt: isoUtc(sessions.createdAt),
  updatedAt: isoUtc(sessions.updatedAt),
};

export type NewSession = {
  id: string;
  title: string | null;
  provider: string;
  model: string;
  systemPrompt: string | null;
};

/** All three timestamps come from one clock_timestamp() call, so they are exactly equal. */
export async function insertSession(db: Executor, values: NewSession): Promise<Session> {
  const now = db
    .$with("now", { ts: sql<Date>`ts`.as("ts") })
    .as(sql`SELECT clock_timestamp() AS ts`);
  const createdAt = sql`(SELECT ${now.ts} FROM ${now})`;
  const [row] = await db
    .with(now)
    .insert(sessions)
    .values({ ...values, lastActivityAt: createdAt, createdAt, updatedAt: createdAt })
    .returning(sessionFields);
  if (row === undefined) {
    throw new Error("INSERT … RETURNING returned no row");
  }
  return row;
}

export async function findSession(db: Executor, id: string): Promise<Session | undefined> {
  const [row] = await db.select(sessionFields).from(sessions).where(eq(sessions.id, id));
  return row;
}

/** Locks the row until the transaction ends; undefined when it does not exist. */
export async function lockSession(tx: Tx, id: string): Promise<ModelPair | undefined> {
  const [row] = await tx
    .select({ provider: sessions.provider, model: sessions.model })
    .from(sessions)
    .where(eq(sessions.id, id))
    .for("update");
  return row;
}

export type SessionChanges = Partial<{
  title: string | null;
  provider: string;
  model: string;
  systemPrompt: string | null;
}>;

/** Settings only: `last_activity_at` belongs to turns and never moves here. */
export async function updateSession(
  tx: Tx,
  id: string,
  changes: SessionChanges,
): Promise<Session | undefined> {
  const [row] = await tx
    .update(sessions)
    .set({ ...changes, updatedAt: sql`clock_timestamp()` })
    .where(eq(sessions.id, id))
    .returning(sessionFields);
  return row;
}

export async function deleteSessionRow(tx: Tx, id: string): Promise<void> {
  await tx.delete(sessions).where(eq(sessions.id, id));
}

/**
 * Keyset page in (last_activity_at DESC, id DESC) order, served by the matching index. Asks
 * for one row more than `limit` so the caller knows whether another page exists.
 */
export async function listSessionsPage(
  db: Executor,
  options: { limit: number; after: SessionCursor | undefined },
): Promise<Session[]> {
  const { limit, after } = options;
  return db
    .select(sessionFields)
    .from(sessions)
    .where(
      after === undefined
        ? undefined
        : sql`(${sessions.lastActivityAt}, ${sessions.id}) < (${after.t}::timestamptz, ${after.id}::uuid)`,
    )
    .orderBy(desc(sessions.lastActivityAt), desc(sessions.id))
    .limit(limit + 1);
}
