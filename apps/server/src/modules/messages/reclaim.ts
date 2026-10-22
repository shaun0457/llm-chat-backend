import { and, eq, sql } from "drizzle-orm";

import type { Database, Tx } from "../../db/client.js";
import { messages } from "../../db/schema.js";

const INTERRUPTED_DETAIL = "The generation was interrupted.";

/**
 * Stale reclaim: fails, as `interrupted`, every assistant message of this session that is still
 * generating `thresholdMs` after its attempt started. The threshold (deadline + terminal-write
 * budget + grace) is longer than any live job can run, so such a row has no job behind it: its
 * process crashed, shut down, or could not store the final state. Both sides of the comparison
 * use the database clock. Partial content is kept. A worker that is somehow still running is
 * fenced by the status predicate of its next write.
 *
 * Every session-scoped read and write runs this first: inside its transaction right after the
 * session lock, or as its own statement before a read. Usually it matches nothing; the partial
 * unique index on generating rows serves it. Returns how many rows it reclaimed.
 */
export async function reclaimStale(
  executor: Database | Tx,
  sessionId: string,
  thresholdMs: number,
): Promise<number> {
  const rows = await executor
    .update(messages)
    .set({
      status: "failed",
      errorCode: "interrupted",
      errorDetail: INTERRUPTED_DETAIL,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.status, "generating"),
        sql`${messages.startedAt} < clock_timestamp() - ${thresholdMs}::integer * interval '1 millisecond'`,
      ),
    )
    .returning({ id: messages.id });
  return rows.length;
}
