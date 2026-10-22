import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createRetention } from "../../src/modules/sessions/retention.js";
import { createSessionsService } from "../../src/modules/sessions/service.js";
import { TEST_ENV, makeTestApp, testJobs } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { type LogCapture, captureLogs } from "../helpers/log-capture.js";
import { allMessages, createSession, eventually, send } from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";
import { closeListeningApp, listen } from "../helpers/sse-client.js";

const testDb = useTestDatabase();

/** Test SQL: moves a session's last activity `days` into the past. */
async function age(sessionId: string, days: number): Promise<void> {
  await testDb.db.drizzle.execute(
    sql`UPDATE sessions SET last_activity_at = clock_timestamp() - ${days}::integer * interval '1 day'
        WHERE id = ${sessionId}`,
  );
}

/** The database clock now, as the ISO timestamp a retention run would use as its cutoff. */
async function databaseNow(): Promise<string> {
  const result = await testDb.db.drizzle.execute<{ now: string }>(
    sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`,
  );
  return result.rows[0]?.now ?? "";
}

function sessionsService() {
  const { registry } = testProviders();
  return createSessionsService({
    db: testDb.db,
    registry,
    staleThresholdMs: loadConfig(TEST_ENV).staleThresholdMs,
    jobs: testJobs(testDb.db),
  });
}

async function exists(app: FastifyInstance, sessionId: string): Promise<boolean> {
  const response = await app.inject({ method: "GET", url: `/sessions/${sessionId}` });
  return response.statusCode === 200;
}

const retentionLogs = (logs: LogCapture) =>
  logs.entries().filter((entry) => entry.msg === "retention run finished");

describe("retention.toctou", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("skips a candidate that became active after it was selected, keeping it and its messages", async () => {
    app = makeTestApp({ db: testDb.db });
    const session = await createSession(app);
    // Selected as a candidate: the cutoff is after its last activity.
    const cutoff = await databaseNow();
    // Then it becomes active again.
    expect((await send(app, session.id, { content: "Still here" })).statusCode).toBe(200);

    const outcome = await sessionsService().deleteSession(session.id, { inactiveBefore: cutoff });

    expect(outcome).toBe("skipped");
    expect(await exists(app, session.id)).toBe(true);
    expect(await allMessages(app, session.id)).toHaveLength(2);
  });

  it("deletes a candidate that stayed inactive since it was selected", async () => {
    app = makeTestApp({ db: testDb.db });
    const session = await createSession(app);
    const cutoff = await databaseNow();

    const outcome = await sessionsService().deleteSession(session.id, { inactiveBefore: cutoff });

    expect(outcome).toBe("deleted");
    expect(await exists(app, session.id)).toBe(false);
  });
});

describe("retention.run", () => {
  let app: FastifyInstance;
  let logs: LogCapture;
  let listening = false;

  function start(env: Record<string, string>): void {
    logs = captureLogs();
    listening = false;
    app = makeTestApp({
      db: testDb.db,
      config: loadConfig({ ...TEST_ENV, LOG_LEVEL: "info", ...env }),
      logStream: logs.stream,
    });
  }

  afterEach(async () => {
    await (listening ? closeListeningApp(app) : app.close());
  });

  it("deletes the sessions inactive for longer than RETENTION_DAYS, keeps the others and logs counts", async () => {
    start({ RETENTION_DAYS: "7" });
    const old = [await createSession(app), await createSession(app), await createSession(app)];
    for (const session of old) {
      await age(session.id, 8);
      await send(app, session.id, { content: "Old news" });
      await age(session.id, 8);
    }
    const recent = await createSession(app);
    await age(recent.id, 6);
    const fresh = await createSession(app);

    const result = await app.retention?.runOnce();

    expect(result).toEqual({ deleted: 3, skipped: 0 });
    for (const session of old) {
      expect(await exists(app, session.id)).toBe(false);
    }
    expect(await exists(app, recent.id)).toBe(true);
    expect(await exists(app, fresh.id)).toBe(true);
    expect(retentionLogs(logs)).toEqual([
      expect.objectContaining({ deleted: 3, skipped: 0, level: 30 }),
    ]);
  });

  it("works through more candidates than one batch holds", async () => {
    start({});
    const old = [await createSession(app), await createSession(app), await createSession(app)];
    for (const session of old) {
      await age(session.id, 30);
    }
    const retention = createRetention({
      db: testDb.db,
      sessions: sessionsService(),
      days: 7,
      intervalMs: 3_600_000,
      log: app.log,
      batchSize: 2,
    });

    const result = await retention.runOnce();

    expect(result.deleted).toBeGreaterThanOrEqual(3);
    for (const session of old) {
      expect(await exists(app, session.id)).toBe(false);
    }
  });

  it("is off without RETENTION_DAYS: nothing is deleted, however often the interval would run", async () => {
    start({ RETENTION_INTERVAL_MS: "20" });
    await listen(app);
    listening = true;
    const old = await createSession(app);
    await age(old.id, 365);

    await sleep(200);

    expect(app.retention).toBeNull();
    expect(await exists(app, old.id)).toBe(true);
    expect(retentionLogs(logs)).toEqual([]);
  });

  it("runs on its interval once the server listens, and stops when the app closes", async () => {
    start({ RETENTION_DAYS: "7", RETENTION_INTERVAL_MS: "20" });
    const old = await createSession(app);
    await age(old.id, 8);
    await sleep(100);
    // Not listening yet: no run.
    expect(retentionLogs(logs)).toEqual([]);

    await listen(app);
    listening = true;
    await eventually(
      async () => exists(app, old.id),
      (stillThere) => !stillThere,
    );
    await closeListeningApp(app);
    listening = false;
    app = makeTestApp({ db: testDb.db });
    const runs = retentionLogs(logs).length;
    await sleep(200);

    expect(runs).toBeGreaterThan(0);
    expect(retentionLogs(logs)).toHaveLength(runs);
  });
});
