import { type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/** ISO 8601 UTC at the database's microsecond precision; a JS Date would keep milliseconds. */
export const isoUtc = (column: PgColumn): SQL<string> =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
