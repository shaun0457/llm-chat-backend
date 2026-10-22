import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import type { Db } from "../../src/db/client.js";

/**
 * A turn left behind by a process that crashed: a user message and a generating assistant
 * message whose attempt started `ageSeconds` ago on the database clock, with no job behind it.
 */
export async function insertCrashedTurn(
  db: Db,
  sessionId: string,
  ageSeconds: number,
): Promise<{ userId: string; assistantId: string }> {
  const userId = randomUUID();
  const assistantId = randomUUID();
  const { rowCount } = await db.pool.query(
    `WITH s AS (
       UPDATE sessions SET next_seq = next_seq + 2 WHERE id = $1 RETURNING next_seq - 2 AS seq
     )
     INSERT INTO messages (id, session_id, seq, role, reply_to_id, content, status, attempt,
                           started_at, provider, model)
     SELECT $2::uuid, $1::uuid, s.seq, 'user', NULL::uuid, 'Hi', 'completed', 1,
            NULL::timestamptz, NULL, NULL FROM s
     UNION ALL
     SELECT $3::uuid, $1::uuid, s.seq + 1, 'assistant', $2::uuid, 'Half an answer', 'generating',
            1, clock_timestamp() - $4::int * interval '1 second', 'demo', 'demo' FROM s`,
    [sessionId, userId, assistantId, ageSeconds],
  );
  expect(rowCount).toBe(2);
  return { userId, assistantId };
}
