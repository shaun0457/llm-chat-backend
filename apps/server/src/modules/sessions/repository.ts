import { asc, desc, eq, sql } from "drizzle-orm";

import type { Database, Tx } from "../../db/client.js";
import { sessions } from "../../db/schema.js";
import { isoUtc } from "../../db/timestamps.js";
import type { SessionCursor } from "./cursor.js";
import type { Session } from "./schemas.js";

type Executor = Database | Tx;

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

/** What a locked session offers to the code holding its lock. */
export type LockedSession = {
  title: string | null;
  provider: string;
  model: string;
  systemPrompt: string | null;
  nextSeq: number;
};

/** Locks the row until the transaction ends; undefined when it does not exist. */
export async function lockSession(tx: Tx, id: string): Promise<LockedSession | undefined> {
  const [row] = await tx
    .select({
      title: sessions.title,
      provider: sessions.provider,
      model: sessions.model,
      systemPrompt: sessions.systemPrompt,
      nextSeq: sessions.nextSeq,
    })
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

/**
 * Locks the row until the transaction ends and tells whether the session was active at or
 * after `since` (an ISO timestamp, compared at the database's precision); undefined when the
 * session does not exist.
 */
export async function lockSessionActiveSince(
  tx: Tx,
  id: string,
  since: string,
): Promise<{ active: boolean } | undefined> {
  const [row] = await tx
    .select({ active: sql<boolean>`${sessions.lastActivityAt} >= ${since}::timestamptz` })
    .from(sessions)
    .where(eq(sessions.id, id))
    .for("update");
  return row;
}

/**
 * Up to `limit` sessions last active before `cutoff`, oldest first, after the (time, id) pair
 * `after` when given: a keyset walk, so each run makes progress even past skipped sessions.
 */
export async function inactiveSessionsPage(
  db: Executor,
  options: { cutoff: string; after: { t: string; id: string } | undefined; limit: number },
): Promise<Array<{ id: string; lastActivityAt: string }>> {
  const { cutoff, after, limit } = options;
  return db
    .select({ id: sessions.id, lastActivityAt: isoUtc(sessions.lastActivityAt) })
    .from(sessions)
    .where(
      after === undefined
        ? sql`${sessions.lastActivityAt} < ${cutoff}::timestamptz`
        : sql`${sessions.lastActivityAt} < ${cutoff}::timestamptz
              AND (${sessions.lastActivityAt}, ${sessions.id}) > (${after.t}::timestamptz, ${after.id}::uuid)`,
    )
    .orderBy(asc(sessions.lastActivityAt), asc(sessions.id))
    .limit(limit);
}

/** Now minus `days` on the database clock, as an ISO timestamp at microsecond precision. */
export async function cutoffDaysAgo(db: Executor, days: number): Promise<string> {
  const result = await db.execute<{ cutoff: string }>(
    sql`SELECT to_char((clock_timestamp() - ${days}::integer * interval '1 day') AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff`,
  );
  const cutoff = result.rows[0]?.cutoff;
  if (cutoff === undefined) {
    throw new Error("SELECT clock_timestamp() returned no row");
  }
  return cutoff;
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
