import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/** Arbitrary, fixed key: every migration runner of this app waits on the same advisory lock. */
export const MIGRATION_LOCK_KEY = 7_340_412_001;

/** Where drizzle records applied migrations: one row per file, `created_at` = journal `when`. */
export const MIGRATIONS_SCHEMA = "drizzle";
export const MIGRATIONS_TABLE = "__drizzle_migrations";

/**
 * Applies pending migrations while holding a session-level advisory lock. The lock and the
 * migrator share one dedicated connection, so a second runner waits, then finds nothing to do.
 * Closing the connection also releases the lock if the explicit unlock never runs.
 */
export async function runMigrations(connectionString: string, migrationsFolder: string) {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await migrate(drizzle({ client }), {
        migrationsFolder,
        migrationsSchema: MIGRATIONS_SCHEMA,
        migrationsTable: MIGRATIONS_TABLE,
      });
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}
