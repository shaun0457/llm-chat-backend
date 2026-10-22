import Fastify, { type FastifyInstance } from "fastify";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import type { LlmProvider } from "../../src/llm/port.js";
import type { JobEnd, JobRegistry } from "../../src/modules/messages/jobs.js";
import { TEST_ENV, makeTestApp, testJobs } from "../helpers/app.js";
import { clockJumpingAfterFirstReading } from "../helpers/clock.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider } from "../helpers/fake-llm.js";
import { captureLogs } from "../helpers/log-capture.js";
import { createSession, eventually, getMessage, send } from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";

const testDb = useTestDatabase();

describe("deadline", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe("fractional remaining time", () => {
    const DEADLINE_MS = 10_000;
    /** As if admission took all but 250.75 ms of the deadline. */
    const clock = () => clockJumpingAfterFirstReading(DEADLINE_MS - 250.75);
    const config = loadConfig({ ...TEST_ENV, GENERATION_DEADLINE_MS: String(DEADLINE_MS) });

    it("generates normally within what is left; no RangeError escapes worker startup", async () => {
      const fake = new FakeLlmProvider().script({ deltas: ["Quick"] });
      app = makeTestApp({ db: testDb.db, config, clock: clock(), ...testProviders({ llm: fake }) });
      const session = await createSession(app);

      const response = await send(app, session.id, { content: "Hi" });

      expect(response.statusCode).toBe(200);
      expect(response.json().assistantMessage).toMatchObject({
        status: "completed",
        content: "Quick",
      });
    });

    it("stops the generation when what was left runs out, not the whole deadline later", async () => {
      const fake = new FakeLlmProvider().script({ deltas: ["Slow"], hang: true });
      app = makeTestApp({ db: testDb.db, config, clock: clock(), ...testProviders({ llm: fake }) });
      const session = await createSession(app);

      // The whole deadline (10 s) would exceed the test's own 5 s timeout.
      const response = await send(app, session.id, { content: "Hi" });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({
        code: "llm_timeout",
        assistantMessage: { status: "failed", errorCode: "llm_timeout", content: "Slow" },
      });
    });
  });

  it("deadline.expiry: a provider that never finishes fails as llm_timeout with its partial text", async () => {
    const config = loadConfig({ ...TEST_ENV, GENERATION_DEADLINE_MS: "300" });
    const fake = new FakeLlmProvider().script({ deltas: ["Par", "tial"], hang: true });
    app = makeTestApp({ db: testDb.db, config, ...testProviders({ llm: fake }) });
    const session = await createSession(app);

    const response = await send(app, session.id, { content: "Hi" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      code: "llm_timeout",
      assistantMessage: { status: "failed", errorCode: "llm_timeout", content: "Partial" },
    });
    expect(fake.signals[0]?.aborted).toBe(true);
    const stored = await getMessage(app, session.id, response.json().assistantMessage.id);
    expect(stored.json()).toMatchObject({ status: "failed", errorCode: "llm_timeout" });
    // The session is free again.
    const next = await send(app, session.id, { content: "Again" });
    expect(next.statusCode).toBe(200);
  });

  it("deadline.no-time-left: admission that outlasted the deadline fails without calling the provider", async () => {
    const DEADLINE_MS = 1_000;
    const config = loadConfig({ ...TEST_ENV, GENERATION_DEADLINE_MS: String(DEADLINE_MS) });
    const fake = new FakeLlmProvider();
    app = makeTestApp({
      db: testDb.db,
      config,
      // As if the admitting transaction took longer than the whole deadline to commit.
      clock: clockJumpingAfterFirstReading(DEADLINE_MS + 1),
      ...testProviders({ llm: fake }),
    });
    const session = await createSession(app);

    const response = await send(app, session.id, { content: "Hi" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      code: "llm_timeout",
      assistantMessage: { status: "failed", errorCode: "llm_timeout", content: "" },
    });
    expect(fake.requests).toHaveLength(0);
    expect((await send(app, session.id, { content: "Again" })).statusCode).toBe(200);
  });

  it("deadline.expiry also ends a generation whose provider ignores the abort signal", async () => {
    const config = loadConfig({ ...TEST_ENV, GENERATION_DEADLINE_MS: "300" });
    const deaf: LlmProvider = {
      id: "deaf",
      async *stream() {
        yield { type: "delta", text: "Deaf" };
        // Never continues and never looks at its signal.
        await new Promise(() => {});
      },
    };
    app = makeTestApp({ db: testDb.db, config, ...testProviders({ llm: deaf }) });
    const session = await createSession(app);

    const response = await send(app, session.id, { content: "Hi" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      code: "llm_timeout",
      assistantMessage: { status: "failed", errorCode: "llm_timeout", content: "Deaf" },
    });
  });

  it("stores an answer as soon as its finish event arrives, even if the stream stays open", async () => {
    const config = loadConfig({ ...TEST_ENV, GENERATION_DEADLINE_MS: "300" });
    const lingering: LlmProvider = {
      id: "lingering",
      async *stream() {
        yield { type: "delta", text: "Complete" };
        yield { type: "finish", reason: "stop", usage: null };
        // The upstream connection is not closed yet (and the signal is ignored).
        await new Promise(() => {});
      },
    };
    app = makeTestApp({ db: testDb.db, config, ...testProviders({ llm: lingering }) });
    const session = await createSession(app);

    const response = await send(app, session.id, { content: "Hi" });

    expect(response.statusCode).toBe(200);
    expect(response.json().assistantMessage).toMatchObject({
      status: "completed",
      content: "Complete",
      finishReason: "stop",
    });
  });

  it("deadline.expiry also ends a generation whose history read is stuck behind a lock", async () => {
    const LOCK_HELD_MS = 3_000;
    const config = loadConfig({
      ...TEST_ENV,
      GENERATION_DEADLINE_MS: "300",
      TERMINAL_STATEMENT_TIMEOUT_MS: "200",
      TERMINAL_WRITE_BUDGET_MS: "300",
    });
    const locker = new pg.Client({ connectionString: testDb.url });
    await locker.connect();
    const logs = captureLogs();
    const inner = testJobs(testDb.db, {
      config,
      log: Fastify({ logger: { level: "info", stream: logs.stream } }).log,
    });
    let locked: Promise<unknown> | undefined;
    let ended: Promise<{ end: JobEnd; afterMs: number }> | undefined;
    const jobs: JobRegistry = {
      ...inner,
      reserve() {
        // Requested while the admitting transaction holds its lock on messages, so it is
        // granted at that commit and queues ahead of the job's history read.
        locked = locker.query("BEGIN; LOCK TABLE messages IN ACCESS EXCLUSIVE MODE");
        return inner.reserve();
      },
      start(spec) {
        const startedAt = performance.now();
        const job = inner.start(spec);
        ended = job.finished.then((end) => ({ end, afterMs: performance.now() - startedAt }));
        return job;
      },
    };
    const fake = new FakeLlmProvider().script({ deltas: ["Never"] });
    app = makeTestApp({ db: testDb.db, config, jobs, ...testProviders({ llm: fake }) });
    const session = await createSession(app);
    let releaseAt: NodeJS.Timeout | undefined;
    try {
      const pending = send(app, session.id, { content: "Hi" }, { prefer: "respond-async" });
      // Granted once the admission commits.
      await eventuallyDefined(() => locked);
      releaseAt = setTimeout(() => void locker.query("COMMIT").catch(() => {}), LOCK_HELD_MS);

      const outcome = await eventuallyDefined(() => ended);

      expect(outcome.afterMs).toBeLessThan(LOCK_HELD_MS / 2);
      // The final write is stuck behind the same lock; reclaim will fail the turn later.
      expect(outcome.end).toBe("write_failed");
      expect(fake.requests).toEqual([]);
      // The abandoned read is cancelled in the database too: it does not keep its pooled
      // connection until the lock goes away.
      expect(await historyReadsWaitingAfter(LOCK_HELD_MS / 3)).toBe(0);
      expect((await pending).statusCode).toBe(202);
      // The cancelled read is logged by its SQLSTATE only: drizzle's error quotes the query and
      // its parameters (here the session id).
      const readFailure = logs
        .entries()
        .find((entry) => entry.msg === "reading the history failed");
      expect(readFailure).toMatchObject({ code: "57014" });
      const logged = logs.lines().join("\n");
      expect(logged).not.toContain("Failed query");
      expect(logged).not.toContain(session.id);
    } finally {
      clearTimeout(releaseAt);
      await locker.query("COMMIT").catch(() => {});
      await locker.end();
    }
  }, 15_000);
});

it("shutdown also gets a history read stuck behind a lock cancelled in the database", async () => {
  const config = loadConfig({
    ...TEST_ENV,
    // Far beyond the test: only the statement timeout can end the read in time. It is long
    // enough for the test to see the read waiting before the shutdown begins.
    GENERATION_DEADLINE_MS: "60000",
    TERMINAL_STATEMENT_TIMEOUT_MS: "1500",
    TERMINAL_WRITE_BUDGET_MS: "300",
  });
  const locker = new pg.Client({ connectionString: testDb.url });
  await locker.connect();
  const inner = testJobs(testDb.db, { config });
  let locked: Promise<unknown> | undefined;
  let started: true | undefined;
  const jobs: JobRegistry = {
    ...inner,
    reserve() {
      // As above: granted at the admission's commit, ahead of the job's history read.
      locked = locker.query("BEGIN; LOCK TABLE messages IN ACCESS EXCLUSIVE MODE");
      return inner.reserve();
    },
    start(spec) {
      const job = inner.start(spec);
      started = true;
      return job;
    },
  };
  const current = makeTestApp({
    db: testDb.db,
    config,
    jobs,
    ...testProviders({ llm: new FakeLlmProvider() }),
  });
  try {
    const session = await createSession(current);
    const pending = send(current, session.id, { content: "Hi" }, { prefer: "respond-async" });
    await eventuallyDefined(() => locked);
    await eventuallyDefined(() => (started ? Promise.resolve(started) : undefined));
    // The history read is really waiting for the lock before the shutdown begins.
    const reader = await eventually(waitingHistoryRead, (pid) => pid !== undefined);

    const closed = inner.shutdown(2_000);

    // Shutdown stops waiting for the read at once; the database must not keep running it until
    // the deadline either, or closing the pool would wait for its connection. While the lock
    // is still held, the read is cancelled and its connection is back in the pool: idle, or
    // already running something else (the cancelled write's tries reuse pooled connections).
    await eventually(
      async () =>
        (
          await testDb.db.pool.query<{ state: string | null; query: string | null }>(
            "SELECT state, query FROM pg_stat_activity WHERE pid = $1",
            [reader],
          )
        ).rows[0],
      (row) =>
        row !== undefined &&
        (row.state === "idle" || !(row.query ?? "").startsWith('select "id", "seq", "role"')),
      3_000,
    );
    expect(await waitingHistoryRead()).toBeUndefined();
    expect(testDb.db.pool.waitingCount).toBe(0);
    await locker.query("COMMIT");
    await closed;
    await pending;
  } finally {
    await locker.query("COMMIT").catch(() => {});
    await locker.end();
    await current.close();
  }
}, 15_000);

/** The backend of a history read (the job's select of id, seq, role …) waiting for a lock. */
async function waitingHistoryRead(): Promise<number | undefined> {
  const { rows } = await testDb.db.pool.query<{ pid: number }>(
    "SELECT pid FROM pg_stat_activity" +
      " WHERE wait_event_type = 'Lock' AND datname = current_database()" +
      ` AND query LIKE 'select "id", "seq", "role"%'`,
  );
  return rows[0]?.pid;
}

/**
 * History reads (the job's select of id, seq, role …) waiting for a lock, polled until none are
 * left or `ms` pass. The request's own read of the turn waits too; request-path timeouts are
 * not part of this ticket.
 */
async function historyReadsWaitingAfter(ms: number): Promise<number> {
  const until = performance.now() + ms;
  for (;;) {
    const { rows } = await testDb.db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity" +
        " WHERE wait_event_type = 'Lock' AND datname = current_database()" +
        ` AND query LIKE 'select "id", "seq", "role"%'`,
    );
    const waiting = rows[0]?.n ?? 0;
    if (waiting === 0 || performance.now() >= until) {
      return waiting;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** `read()`'s value once it is defined. */
async function eventuallyDefined<T>(read: () => Promise<T> | undefined): Promise<T> {
  for (;;) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
