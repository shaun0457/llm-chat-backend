import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, inject } from "vitest";

import { type Db, createDb } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { MIGRATIONS_FOLDER } from "../../src/paths.js";

export type TestDatabase = { db: Db; url: string; drop(): Promise<void> };

/** "all": a clone of the migrated template; "none": empty; "all-but-last": one migration short. */
export type Migrations = "all" | "none" | "all-but-last";

async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: inject("postgres").adminUrl });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

async function migrateAllButLast(url: string): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), "migrations-"));
  try {
    await cp(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: unknown[] };
    journal.entries = journal.entries.slice(0, -1);
    await writeFile(journalPath, JSON.stringify(journal));
    await runMigrations(url, folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Creates a database of its own on the shared test container. */
export async function createTestDatabase(migrations: Migrations = "all"): Promise<TestDatabase> {
  const { adminUrl, templateDatabase } = inject("postgres");
  const name = `test_${randomBytes(6).toString("hex")}`;
  const template = migrations === "all" ? ` TEMPLATE ${templateDatabase}` : "";
  await withAdmin((admin) => admin.query(`CREATE DATABASE ${name}${template}`));

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  if (migrations === "all-but-last") {
    await migrateAllButLast(url.toString());
  }

  const db = createDb({
    connectionString: url.toString(),
    // Test databases are dropped with FORCE, which kills idle pooled connections.
    onPoolError: () => {},
  });
  return {
    db,
    url: url.toString(),
    drop: async () => {
      await db.close();
      await withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}

/** A database for the whole test file: created before its first test, dropped after its last. */
export function useTestDatabase(migrations: Migrations = "all"): {
  readonly db: Db;
  readonly url: string;
} {
  let current: TestDatabase | undefined;
  beforeAll(async () => {
    current = await createTestDatabase(migrations);
  });
  afterAll(async () => {
    await current?.drop();
  });

  const get = (): TestDatabase => {
    if (current === undefined) {
      throw new Error("the test database is created in beforeAll; use it inside a test");
    }
    return current;
  };
  return {
    get db() {
      return get().db;
    },
    get url() {
      return get().url;
    },
  };
}
