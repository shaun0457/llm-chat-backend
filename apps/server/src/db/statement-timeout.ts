import { sql } from "drizzle-orm";

import type { Tx } from "./client.js";

/**
 * Limits every later statement of `tx` to `ms` with `SET LOCAL statement_timeout`. `ms` must be
 * a whole number of at least 1: PostgreSQL reads 0 as "no limit".
 * The database then cancels a statement that takes longer (SQLSTATE 57014) and the connection
 * goes back to the pool usable, even if the caller stopped waiting for it long before.
 */
export async function limitStatements(tx: Tx, ms: number): Promise<void> {
  if (!Number.isInteger(ms) || ms < 1) {
    throw new RangeError(`a statement timeout must be a whole number of at least 1 ms: ${ms}`);
  }
  await tx.execute(sql`SELECT set_config('statement_timeout', ${`${ms}ms`}, true)`);
}
