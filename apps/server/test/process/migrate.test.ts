import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { MIGRATION_LOCK_KEY } from "../../src/db/migrate.js";
import { useTestDatabase } from "../helpers/db.js";

const SERVER_DIR = fileURLToPath(new URL("../..", import.meta.url));

type Run = { code: number | null; stdout: string; stderr: string };

function runMigrate(env: Record<string, string>): { done: Promise<Run>; exited: () => boolean } {
  const child = spawn(process.execPath, ["dist/migrate.js"], {
    cwd: SERVER_DIR,
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  let stdout = "";
  let stderr = "";
  let exited = false;
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const done = new Promise<Run>((resolve) =>
    child.once("close", (code) => {
      exited = true;
      resolve({ code, stdout, stderr });
    }),
  );
  return { done, exited: () => exited };
}

async function query<T extends pg.QueryResultRow>(url: string, text: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text)).rows;
  } finally {
    await client.end();
  }
}

const appliedMigrations = (url: string) =>
  query<{ hash: string }>(url, "SELECT hash FROM drizzle.__drizzle_migrations");

const sessionsTable = async (url: string) =>
  (
    await query<{ name: string | null }>(url, "SELECT to_regclass('public.sessions')::text AS name")
  )[0]?.name;

describe("migrate entry (built dist/migrate.js)", () => {
  describe("on an empty database", () => {
    const testDb = useTestDatabase("none");

    it("exits 0, creates sessions, and a second run is a no-op", async () => {
      const first = await runMigrate({ DATABASE_URL: testDb.url }).done;
      expect(first).toMatchObject({ code: 0 });
      expect(await sessionsTable(testDb.url)).toBe("sessions");
      const afterFirst = await appliedMigrations(testDb.url);
      expect(afterFirst).toHaveLength(1);

      const second = await runMigrate({ DATABASE_URL: testDb.url }).done;
      expect(second).toMatchObject({ code: 0 });
      expect(await appliedMigrations(testDb.url)).toEqual(afterFirst);
    }, 30_000);
  });

  describe("two concurrent runs", () => {
    const testDb = useTestDatabase("none");

    it("both exit 0 and each migration is recorded once", async () => {
      const [a, b] = await Promise.all([
        runMigrate({ DATABASE_URL: testDb.url }).done,
        runMigrate({ DATABASE_URL: testDb.url }).done,
      ]);

      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      expect(await appliedMigrations(testDb.url)).toHaveLength(1);
    }, 30_000);
  });

  describe("while another runner holds the migration lock", () => {
    const testDb = useTestDatabase("none");

    it("waits for the lock, then migrates", async () => {
      const holder = new pg.Client({ connectionString: testDb.url });
      await holder.connect();
      try {
        await holder.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
        const run = runMigrate({ DATABASE_URL: testDb.url });

        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(run.exited()).toBe(false);
        expect(await sessionsTable(testDb.url)).toBeNull();

        await holder.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
        expect((await run.done).code).toBe(0);
        expect(await sessionsTable(testDb.url)).toBe("sessions");
      } finally {
        await holder.end();
      }
    }, 30_000);
  });

  it("exits 1 when the database is unreachable, without printing the password", async () => {
    const run = await runMigrate({
      DATABASE_URL: "postgres://app:s3cret-pw@127.0.0.1:9/app",
    }).done;

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("Migration failed");
    expect(run.stdout + run.stderr).not.toContain("s3cret-pw");
  }, 30_000);

  it("exits 1 naming DATABASE_URL when it is missing", async () => {
    const run = await runMigrate({}).done;

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("DATABASE_URL");
  });
});
