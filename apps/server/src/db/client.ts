import { type NodePgDatabase, drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type Db = Readonly<{
  pool: pg.Pool;
  drizzle: Database;
  /** Runs `fn` in one transaction on one pooled connection; rolls back if it throws. */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Ends the pool; safe to call more than once. */
  close(): Promise<void>;
}>;

export type DbOptions = {
  connectionString: string;
  /** An idle pooled connection failed (e.g. the server restarted); pg would otherwise crash. */
  onPoolError: (error: Error) => void;
  connectionTimeoutMillis?: number;
  max?: number;
};

const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

export function createDb(options: DbOptions): Db {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    ...(options.max === undefined ? {} : { max: options.max }),
  });
  pool.on("error", options.onPoolError);

  const database = drizzle({ client: pool, schema });
  let ended: Promise<void> | undefined;

  return Object.freeze({
    pool,
    drizzle: database,
    tx: <T>(fn: (tx: Tx) => Promise<T>) => database.transaction(fn),
    close: () => (ended ??= pool.end()),
  });
}
