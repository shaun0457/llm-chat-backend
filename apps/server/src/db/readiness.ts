import { readMigrationFiles } from "drizzle-orm/migrator";

import type { Db } from "./client.js";
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from "./migrate.js";

export type Readiness = "ready" | "database_unreachable" | "migrations_pending";
export type ReadinessCheck = () => Promise<Readiness>;

const UNDEFINED_TABLE = "42P01";
const INVALID_SCHEMA_NAME = "3F000";

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

  return async () => {
    try {
      await db.pool.query("SELECT 1");
    } catch {
      return "database_unreachable";
    }

    let applied: Set<string>;
    try {
      const { rows } = await db.pool.query<{ created_at: string }>(
        `SELECT created_at FROM "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`,
      );
      applied = new Set(rows.map((row) => String(row.created_at)));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return code === UNDEFINED_TABLE || code === INVALID_SCHEMA_NAME
        ? "migrations_pending"
        : "database_unreachable";
    }

    const same = applied.size === bundled.size && [...bundled].every((id) => applied.has(id));
    return same ? "ready" : "migrations_pending";
  };
}
