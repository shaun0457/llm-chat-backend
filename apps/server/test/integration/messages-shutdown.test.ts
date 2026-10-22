import type { FastifyInstance } from "fastify";
import { performance } from "node:perf_hooks";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { jobShutdownWaitMs } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { JobRegistry } from "../../src/modules/messages/jobs.js";
import { TEST_ENV, makeTestApp, testJobs } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider } from "../helpers/fake-llm.js";
import { type Message, createSession, eventually, getMessage, send } from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";

const testDb = useTestDatabase();

describe("shutdown", () => {
  let app: FastifyInstance | undefined;
  /** A second app on the same database, to read rows after `app` has closed. */
  let reader: FastifyInstance;

  beforeAll(async () => {
    reader = makeTestApp({ db: testDb.db });
    // Test-only fault injection: storing "cancelled" for answers starting with "Stuck" sleeps.
    await testDb.db.pool.query(`
      CREATE FUNCTION stuck_cancel() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.error_code = 'cancelled' AND NEW.content LIKE 'Stuck%' THEN
          PERFORM pg_sleep(5);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER stuck_cancel BEFORE UPDATE ON messages
        FOR EACH ROW EXECUTE FUNCTION stuck_cancel();
    `);
  });
  afterAll(async () => {
    await reader.close();
    await testDb.db.pool.query(
      "DROP TRIGGER stuck_cancel ON messages; DROP FUNCTION stuck_cancel();",
    );
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** Starts a turn that hangs after `deltas` and returns once they are stored. */
  async function generating(current: FastifyInstance, deltas: string[]) {
    const session = await createSession(current);
    const response = await send(
      current,
      session.id,
      { content: "Hi" },
      { prefer: "respond-async" },
    );
    expect(response.statusCode).toBe(202);
    const assistantId: string = response.json().assistantMessage.id;
    await eventually(
      async () => (await getMessage(reader, session.id, assistantId)).json() as Message,
      (message) => message.content === deltas.join(""),
    );
    return { sessionId: session.id, assistantId };
  }

  it("ends a generation in flight as failed / cancelled with its partial text", async () => {
    const config = loadConfig(TEST_ENV);
    const fake = new FakeLlmProvider().script({ deltas: ["Half", " done"], hang: true });
    const current = makeTestApp({ db: testDb.db, config, ...testProviders({ llm: fake }) });
    app = current;
    const turn = await generating(current, ["Half", " done"]);

    const started = performance.now();
    await current.close();
    app = undefined;

    expect(performance.now() - started).toBeLessThan(jobShutdownWaitMs(config));
    expect(fake.signals[0]?.aborted).toBe(true);
    const stored = await getMessage(reader, turn.sessionId, turn.assistantId);
    expect(stored.json()).toMatchObject({
      status: "failed",
      errorCode: "cancelled",
      errorDetail: "The server shut down before the answer was finished.",
      content: "Half done",
    });
    // The session is usable again at once (no wait for stale reclaim).
    expect((await send(reader, turn.sessionId, { content: "Again" })).statusCode).toBe(200);
  });

  it("still closes within the job wait when the cancelled state cannot be stored; reclaim is the backstop", async () => {
    const config = loadConfig({
      ...TEST_ENV,
      TERMINAL_STATEMENT_TIMEOUT_MS: "100",
      TERMINAL_WRITE_BUDGET_MS: "300",
    });
    const fake = new FakeLlmProvider().script({ deltas: ["Stuck"], hang: true });
    const current = makeTestApp({ db: testDb.db, config, ...testProviders({ llm: fake }) });
    app = current;
    const turn = await generating(current, ["Stuck"]);

    const started = performance.now();
    await current.close();
    app = undefined;

    expect(performance.now() - started).toBeLessThan(jobShutdownWaitMs(config));
    const left = await getMessage(reader, turn.sessionId, turn.assistantId);
    expect(left.json()).toMatchObject({ status: "generating", content: "Stuck" });
  });

  it("cancels a turn admitted just as the server began to close, without calling the provider", async () => {
    const inner = testJobs(testDb.db);
    // Shutdown begins between the admitting commit and the job's start.
    const jobs: JobRegistry = {
      ...inner,
      start(spec) {
        void inner.shutdown(1_000);
        return inner.start(spec);
      },
    };
    const fake = new FakeLlmProvider();
    const current = makeTestApp({ db: testDb.db, jobs, ...testProviders({ llm: fake }) });
    app = current;
    const session = await createSession(current);

    const response = await send(current, session.id, { content: "Hi" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      code: "cancelled",
      assistantMessage: { status: "failed", errorCode: "cancelled", content: "" },
    });
    expect(fake.requests).toEqual([]);
  });
});
