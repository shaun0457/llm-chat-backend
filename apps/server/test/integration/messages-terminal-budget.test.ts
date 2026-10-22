import Fastify, { type FastifyInstance } from "fastify";
import { performance } from "node:perf_hooks";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createDb } from "../../src/db/client.js";
import type { JobRegistry } from "../../src/modules/messages/jobs.js";
import { TEST_ENV, makeTestApp, testJobs } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider, createGate } from "../helpers/fake-llm.js";
import { captureLogs } from "../helpers/log-capture.js";
import { allMessages, createSession, eventually, getMessage, send } from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";

const testDb = useTestDatabase();

/** Scheduling and database round trips on top of the budget, for the end-to-end bound. */
const SLACK_MS = 1_000;

/** Counts reservations taken and not yet released, around a real registry. */
function countingReservations(inner: JobRegistry): { jobs: JobRegistry; held: () => number } {
  let held = 0;
  const jobs: JobRegistry = {
    ...inner,
    reserve() {
      const reservation = inner.reserve();
      if (reservation === undefined) {
        return undefined;
      }
      held += 1;
      let released = false;
      return {
        release() {
          if (!released) {
            released = true;
            held -= 1;
          }
          reservation.release();
        },
      };
    },
  };
  return { jobs, held: () => held };
}

describe("terminal-budget", () => {
  let app: FastifyInstance | undefined;

  // Test-only fault injection, limited to answers whose text starts with these markers:
  // "Slow…" makes storing completed sleep far beyond any statement timeout; "Refused…" makes it
  // take one second and then fail; "Stall…" makes flushing the partial text sleep; "Invalid…"
  // makes storing completed fail at once with a constraint violation, as bad data would.
  beforeAll(async () => {
    await testDb.db.pool.query(`
      CREATE FUNCTION terminal_faults() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'completed' AND NEW.content LIKE 'Slow%' THEN
          PERFORM pg_sleep(5);
        ELSIF NEW.status = 'completed' AND NEW.content LIKE 'Refused%' THEN
          PERFORM pg_sleep(1);
          RAISE EXCEPTION 'terminal write refused by the test';
        ELSIF NEW.status = 'completed' AND NEW.content LIKE 'Invalid%' THEN
          RAISE EXCEPTION 'invalid by the test' USING ERRCODE = 'check_violation';
        ELSIF NEW.status = 'generating' AND NEW.content LIKE 'Stall%' THEN
          PERFORM pg_sleep(5);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER terminal_faults BEFORE UPDATE ON messages
        FOR EACH ROW EXECUTE FUNCTION terminal_faults();
    `);
  });
  afterAll(async () => {
    await testDb.db.pool.query(
      "DROP TRIGGER terminal_faults ON messages; DROP FUNCTION terminal_faults();",
    );
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /**
   * Starts a turn whose provider waits at a gate and then answers `answer`; returns once the
   * job runs. Releasing the gate starts the terminal write.
   */
  async function startTurn(env: Record<string, string>, answer: string) {
    const config = loadConfig({ ...TEST_ENV, ...env });
    const logs = captureLogs();
    const counted = countingReservations(
      testJobs(testDb.db, {
        config,
        log: Fastify({ logger: { level: "info", stream: logs.stream } }).log,
      }),
    );
    const fake = new FakeLlmProvider();
    const gate = createGate();
    fake.script({ deltas: [answer], gate: gate.promise, gateAfter: 1 });
    const current = makeTestApp({
      db: testDb.db,
      config,
      jobs: counted.jobs,
      ...testProviders({ llm: fake }),
    });
    app = current;
    const session = await createSession(current);
    const response = await send(
      current,
      session.id,
      { content: "Hi" },
      { prefer: "respond-async" },
    );
    expect(response.statusCode).toBe(202);
    const assistantId: string = response.json().assistantMessage.id;
    const job = counted.jobs.get(assistantId);
    if (job === undefined) {
      throw new Error("expected the generation to be running");
    }
    return { app: current, session, assistantId, job, gate, logs, held: counted.held };
  }

  it("gives up within the budget when every write times out, logs it, and releases its reservation", async () => {
    const BUDGET_MS = 1_000;
    const turn = await startTurn(
      { TERMINAL_STATEMENT_TIMEOUT_MS: "200", TERMINAL_WRITE_BUDGET_MS: String(BUDGET_MS) },
      "Slow answer",
    );
    expect(turn.held()).toBe(1);

    const started = performance.now();
    turn.gate.release();
    const end = await turn.job.finished;
    const elapsed = performance.now() - started;

    expect(end).toBe("write_failed");
    expect(elapsed).toBeLessThan(BUDGET_MS + SLACK_MS);
    expect(turn.held()).toBe(0);
    const failure = turn.logs
      .entries()
      .find((entry) => entry.level === 50 && entry.assistantId === turn.assistantId);
    expect(failure).toMatchObject({ assistantId: turn.assistantId, attempt: 1 });
    expect(failure?.writeAttempts).toBeGreaterThan(1);

    // The row was left generating; once it is older than the stale threshold, any read fails
    // it as interrupted and the session takes new turns again.
    const left = await getMessage(turn.app, turn.session.id, turn.assistantId);
    expect(left.json()).toMatchObject({ status: "generating" });
    await testDb.db.pool.query(
      "UPDATE messages SET started_at = started_at - interval '300 seconds' WHERE id = $1",
      [turn.assistantId],
    );
    const reclaimed = await getMessage(turn.app, turn.session.id, turn.assistantId);
    expect(reclaimed.json()).toMatchObject({ status: "failed", errorCode: "interrupted" });
  }, 15_000);

  it("caps the last retry's statement to what is left of the budget", async () => {
    // The first try takes 1 s and fails; 300 ms are left, then 200 ms after a 100 ms backoff:
    // the retry may only use those, not the 3 s statement timeout.
    const BUDGET_MS = 1_300;
    const turn = await startTurn(
      { TERMINAL_STATEMENT_TIMEOUT_MS: "3000", TERMINAL_WRITE_BUDGET_MS: String(BUDGET_MS) },
      "Refused answer",
    );

    const started = performance.now();
    turn.gate.release();
    const end = await turn.job.finished;
    const elapsed = performance.now() - started;

    expect(end).toBe("write_failed");
    expect(elapsed).toBeLessThan(BUDGET_MS + SLACK_MS);
    expect(turn.held()).toBe(0);
    const failure = turn.logs
      .entries()
      .find((entry) => entry.level === 50 && entry.assistantId === turn.assistantId);
    expect(failure?.writeAttempts).toBe(2);
  });

  it("does not retry a write the database rejects as invalid", async () => {
    const turn = await startTurn(
      { TERMINAL_STATEMENT_TIMEOUT_MS: "200", TERMINAL_WRITE_BUDGET_MS: "3000" },
      "Invalid answer",
    );

    turn.gate.release();

    expect(await turn.job.finished).toBe("write_failed");
    const failure = turn.logs
      .entries()
      .find((entry) => entry.level === 50 && entry.assistantId === turn.assistantId);
    expect(failure).toMatchObject({ writeAttempts: 1, code: "23514" });
    // The database's message can quote the rejected value (the answer): only the code is kept.
    expect(failure).not.toHaveProperty("reason");
    expect(JSON.stringify(failure)).not.toContain("invalid by the test");
    expect(turn.held()).toBe(0);
  });

  it("answers a waiting JSON client 202, not an error, and polling ends once the turn is reclaimed", async () => {
    const config = loadConfig({
      ...TEST_ENV,
      TERMINAL_STATEMENT_TIMEOUT_MS: "100",
      TERMINAL_WRITE_BUDGET_MS: "300",
    });
    const fake = new FakeLlmProvider().script({ deltas: ["Slow", " answer"] });
    const current = makeTestApp({ db: testDb.db, config, ...testProviders({ llm: fake }) });
    app = current;
    const session = await createSession(current);

    const response = await send(current, session.id, { content: "Hi" });

    expect(response.statusCode).toBe(202);
    const { assistantMessage } = response.json();
    expect(assistantMessage).toMatchObject({ status: "generating" });
    expect(response.headers.location).toBe(
      `/sessions/${session.id}/messages/${assistantMessage.id}`,
    );
    await testDb.db.pool.query(
      "UPDATE messages SET started_at = started_at - interval '300 seconds' WHERE id = $1",
      [assistantMessage.id],
    );
    const [, polled] = await eventually(
      () => allMessages(current, session.id),
      (messages) => messages[1]?.status !== "generating",
    );
    expect(polled).toMatchObject({ status: "failed", errorCode: "interrupted" });
  });

  it("never writes once its budget ran out, even from a try still waiting for a connection", async () => {
    // One connection for the app and its jobs, so a test client can starve the terminal write.
    const small = createDb({ connectionString: testDb.url, max: 1, onPoolError: () => {} });
    const reader = makeTestApp({ db: testDb.db });
    try {
      const config = loadConfig({
        ...TEST_ENV,
        TERMINAL_STATEMENT_TIMEOUT_MS: "100",
        TERMINAL_WRITE_BUDGET_MS: "300",
      });
      const jobs = testJobs(small, { config });
      const fake = new FakeLlmProvider();
      const gate = createGate();
      fake.script({ deltas: ["Late answer"], gate: gate.promise, gateAfter: 1 });
      const current = makeTestApp({ db: small, config, jobs, ...testProviders({ llm: fake }) });
      app = current;
      const session = await createSession(current);
      const response = await send(
        current,
        session.id,
        { content: "Hi" },
        { prefer: "respond-async" },
      );
      const assistantId: string = response.json().assistantMessage.id;
      const read = async () => (await getMessage(reader, session.id, assistantId)).json();
      await eventually(read, (message) => message.content === "Late answer");
      const job = jobs.get(assistantId);
      if (job === undefined) {
        throw new Error("expected the generation to be running");
      }

      const held = await small.pool.connect();
      gate.release();
      expect(await job.finished).toBe("write_failed");
      held.release();
      // The try that queued for the connection gets it now; let it run to its end.
      await eventually(
        async () => small.pool.waitingCount === 0 && small.pool.idleCount === small.pool.totalCount,
        (idle) => idle,
      );

      expect(await read()).toMatchObject({ status: "generating" });
    } finally {
      await app?.close();
      app = undefined;
      await reader.close();
      await small.close();
    }
  });

  it("does not wait for a stalled flush longer than one statement timeout", async () => {
    const turn = await startTurn(
      { TERMINAL_STATEMENT_TIMEOUT_MS: "200", TERMINAL_WRITE_BUDGET_MS: "500" },
      "Stalled answer",
    );
    // The first flush of the partial text is now sleeping in the database for 5 s.
    await eventually(
      async () =>
        (
          await testDb.db.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity" +
              " WHERE wait_event = 'PgSleep' AND datname = current_database()",
          )
        ).rows[0]?.n ?? 0,
      (sleeping) => sleeping > 0,
    );

    const started = performance.now();
    turn.gate.release();
    const end = await turn.job.finished;

    // Without the bound the job would sit behind the 5 s flush. The database cancels the flush
    // at its statement timeout, so the final write gets the row and stores the answer.
    expect(performance.now() - started).toBeLessThan(2_500);
    expect(end).toBe("terminal");
    expect(turn.held()).toBe(0);
    // The cancelled flush is logged by its SQLSTATE only: the failed query's parameters hold
    // the partial answer.
    const flushFailure = turn.logs
      .entries()
      .find((entry) => entry.level === 40 && entry.assistantId === turn.assistantId);
    expect(flushFailure).toMatchObject({ code: "57014" });
    expect(JSON.stringify(turn.logs.entries())).not.toContain("Stalled");
    // The flush itself is cancelled in the database at its statement timeout instead of
    // keeping its pooled connection for the whole 5 s.
    await eventually(
      async () =>
        (
          await testDb.db.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity" +
              " WHERE wait_event = 'PgSleep' AND datname = current_database()",
          )
        ).rows[0]?.n ?? 0,
      (sleeping) => sleeping === 0,
      1_000,
    );
  }, 15_000);
});
