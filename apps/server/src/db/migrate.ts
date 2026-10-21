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
 * migrator share one dedicated connection, so a second runner waits (without a deadline), then
 * finds nothing to do. Closing the connection releases the lock, so cleanup failures are
 * ignored and never hide the error that made the run fail.
 */
export async function runMigrations(
  connectionString: string,
  migrationsFolder: string,
): Promise<void> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000 });
  // A connection error between statements surfaces through the next query instead.
  client.on("error", () => {});
  try {
    await client.connect();
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await migrate(drizzle({ client }), {
        migrationsFolder,
        migrationsSchema: MIGRATIONS_SCHEMA,
        migrationsTable: MIGRATIONS_TABLE,
      });
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }
}
