import type { Db } from "../../src/db/client.js";

/**
 * Every row of every table outside the system schemas, as its complete text representation
 * (all columns, whatever their type), for "this text is stored nowhere" assertions. Callers
 * check that discovery found tables and rows, so the scan is never vacuous.
 */
export async function everyRow(db: Db): Promise<{ tables: string[]; rows: string[] }> {
  const { rows: tables } = await db.pool.query<{ schema: string; name: string }>(
    `SELECT table_schema AS schema, table_name AS name
       FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('pg_catalog', 'information_schema')
        AND table_schema NOT LIKE 'pg\\_%'`,
  );
  const rows: string[] = [];
  for (const { schema, name } of tables) {
    const quoted = `"${schema.replaceAll('"', '""')}"."${name.replaceAll('"', '""')}"`;
    const result = await db.pool.query<{ row: string }>(`SELECT t::text AS row FROM ${quoted} t`);
    rows.push(...result.rows.map(({ row }) => row));
  }
  return { tables: tables.map(({ schema, name }) => `${schema}.${name}`), rows };
}
