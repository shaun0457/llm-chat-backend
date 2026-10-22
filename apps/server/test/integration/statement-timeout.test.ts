import { sql } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

/**
 * V2 of the deadlines ticket: the terminal write's per-statement limit. A trigger stands in for
 * a slow database; only rows of the table created here are slowed.
 */
describe("terminal-write statement timeouts (V2)", () => {
  beforeAll(async () => {
    await testDb.db.pool.query(`
      CREATE TABLE v2_rows (id int PRIMARY KEY, status text NOT NULL);
      INSERT INTO v2_rows VALUES (1, 'generating');
      CREATE FUNCTION v2_slow() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(1);
        RETURN NEW;
      END $$;
      CREATE TRIGGER v2_slow BEFORE UPDATE ON v2_rows FOR EACH ROW EXECUTE FUNCTION v2_slow();
    `);
  });
  afterAll(async () => {
    await testDb.db.pool.query("DROP TABLE v2_rows; DROP FUNCTION v2_slow();");
  });

  it("SET LOCAL statement_timeout cancels an UPDATE slowed by a trigger with 57014; the connection stays usable", async () => {
    const db = createDb({ connectionString: testDb.url, max: 1, onPoolError: () => {} });
    try {
      const started = performance.now();
      const error = await db
        .tx(async (tx) => {
          await tx.execute(sql`SELECT set_config('statement_timeout', ${"200ms"}, true)`);
          await tx.execute(sql`UPDATE v2_rows SET status = 'completed' WHERE id = 1`);
        })
        .catch((caught: unknown) => caught);

      expect(pgErrorCode(error)).toBe(QUERY_CANCELED);
      expect(performance.now() - started).toBeLessThan(1_000);
      // The only pooled connection was returned and works: no need to discard it.
      expect(db.pool.totalCount).toBe(1);
      const { rows } = await db.pool.query<{ status: string }>(
        "SELECT status FROM v2_rows WHERE id = 1",
      );
      expect(rows[0]?.status).toBe("generating");
    } finally {
      await db.close();
    }
  });

  it("a transaction the client stops waiting for still ends at its statement timeout and frees the connection", async () => {
    const db = createDb({ connectionString: testDb.url, max: 1, onPoolError: () => {} });
    try {
      const abandoned = db
        .tx(async (tx) => {
          await tx.execute(sql`SELECT set_config('statement_timeout', ${"300ms"}, true)`);
          await tx.execute(sql`UPDATE v2_rows SET status = 'completed' WHERE id = 1`);
        })
        .catch((caught: unknown) => caught);
      // The caller gives up long before the statement ends (as a budget race would).
      await sleep(50);
      expect(db.pool.idleCount).toBe(0);

      expect(pgErrorCode(await abandoned)).toBe(QUERY_CANCELED);
      expect(db.pool.idleCount).toBe(1);
      await expect(db.pool.query("SELECT 1")).resolves.toBeDefined();
    } finally {
      await db.close();
    }
  });
});
