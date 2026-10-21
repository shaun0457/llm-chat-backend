import { readMigrationFiles } from "drizzle-orm/migrator";
import type { QueryConfig } from "pg";

import type { Db } from "./client.js";
import { pgErrorCode } from "./errors.js";
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from "./migrate.js";

export type Readiness = "ready" | "database_unreachable" | "migrations_pending";
export type ReadinessLog = { warn(details: object, message: string): void };
export type ReadinessCheck = (log: ReadinessLog) => Promise<Readiness>;

/** Each probe query gives up after this long; pg then discards the connection. */
const QUERY_TIMEOUT_MS = 2_000;
const UNDEFINED_TABLE = "42P01";
const INVALID_SCHEMA_NAME = "3F000";

/** pg reads `query_timeout` per query at runtime; @types/pg only declares it on the client config. */
function probe(text: string): QueryConfig {
  const config: QueryConfig & { query_timeout: number } = { text, query_timeout: QUERY_TIMEOUT_MS };
  return config;
}

/**
 * Ready when the database answers and the applied migrations are exactly the bundled ones.
 * Compared by journal timestamp (`when`), which is also what drizzle's migrator uses to decide
 * what to apply; a database with migrations this build lacks is not ready either.
 * Reads the bundled journal once; checks the database on every call (no caching).
 */
export function createReadinessCheck(db: Db, migrationsFolder: string): ReadinessCheck {
  const bundled = new Set(
    readMigrationFiles({ migrationsFolder }).map((migration) => String(migration.folderMillis)),
  );

  return async (log) => {
    try {
      await db.pool.query(probe("SELECT 1"));
    } catch (error) {
      log.warn({ err: error }, "readiness: database did not answer");
      return "database_unreachable";
    }

    let applied: Set<string>;
    try {
      const { rows } = await db.pool.query<{ created_at: string }>(
        probe(`SELECT created_at FROM "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`),
      );
      applied = new Set(rows.map((row) => String(row.created_at)));
    } catch (error) {
      const code = pgErrorCode(error);
      if (code === UNDEFINED_TABLE || code === INVALID_SCHEMA_NAME) {
        return "migrations_pending";
      }
      log.warn({ err: error }, "readiness: could not read applied migrations");
      return "database_unreachable";
    }

    const same = applied.size === bundled.size && [...bundled].every((id) => applied.has(id));
    return same ? "ready" : "migrations_pending";
  };
}
