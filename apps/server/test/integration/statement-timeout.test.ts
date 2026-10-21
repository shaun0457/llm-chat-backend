import { sql } from "drizzle-orm";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { createDb } from "../../src/db/client.js";
import { pgErrorCode } from "../../src/db/errors.js";
import { useTestDatabase } from "../helpers/db.js";

const testDb = useTestDatabase();

const QUERY_CANCELED = "57014";

/**
 * V3: how to bound one statement's run time with node-postgres. Terminal writes in the
 * generation ticket need a short limit without affecting the rest of the pool.
 */
describe("per-statement timeouts (V3)", () => {
  it("the pool option statement_timeout cancels every slow statement on its connections", async () => {
    const pool = new pg.Pool({ connectionString: testDb.url, statement_timeout: 200 });
    try {
      const error = await pool.query("SELECT pg_sleep(1)").catch((caught: unknown) => caught);

      expect(pgErrorCode(error)).toBe(QUERY_CANCELED);
    } finally {
      await pool.end();
    }
  });

  it("SET LOCAL statement_timeout bounds statements in one transaction only", async () => {
    const db = createDb({ connectionString: testDb.url, max: 1, onPoolError: () => {} });
    try {
      const error = await db
        .tx(async (tx) => {
          await tx.execute(sql`SELECT set_config('statement_timeout', ${"200ms"}, true)`);
          await tx.execute(sql`SELECT pg_sleep(1)`);
        })
        .catch((caught: unknown) => caught);

      expect(pgErrorCode(error)).toBe(QUERY_CANCELED);
      // Same (only) pooled connection, after the transaction: the limit is gone.
      const after = await db.pool.query<{ statement_timeout: string }>("SHOW statement_timeout");
      expect(after.rows[0]?.statement_timeout).toBe("0");
      await expect(db.pool.query("SELECT pg_sleep(0.3)")).resolves.toBeDefined();
    } finally {
      await db.close();
    }
  });
});
