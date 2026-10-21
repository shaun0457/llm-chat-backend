import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { LlmProvider } from "../../src/llm/port.js";
import { createJobRegistry } from "../../src/modules/messages/jobs.js";
import { makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider } from "../helpers/fake-llm.js";
import { allMessages, createSession, getSession, send } from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";

const testDb = useTestDatabase();

describe("generation robustness", () => {
  let app: FastifyInstance;
  let fake: FakeLlmProvider;

  afterEach(async () => {
    await app.close();
  });

  it("drops U+0000 from the provider's text, which PostgreSQL cannot store", async () => {
    fake = new FakeLlmProvider().script({ deltas: ["a\u0000", "b\u0000c"] });
    app = makeTestApp({ db: testDb.db, ...testProviders({ llm: fake }) });
    const session = await createSession(app);

    const response = await send(app, session.id, { content: "Hi" });

    expect(response.statusCode).toBe(200);
    expect(response.json().assistantMessage).toMatchObject({ status: "completed", content: "abc" });
  });

  describe("when the terminal write fails", () => {
    // Only rows whose answer is exactly this text are refused, so other tests are unaffected.
    beforeAll(async () => {
      await testDb.db.pool.query(`
        CREATE FUNCTION refuse_doomed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.status <> 'generating' AND NEW.content = 'Doomed' THEN
            RAISE EXCEPTION 'terminal write refused by the test';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER refuse_doomed BEFORE UPDATE ON messages
          FOR EACH ROW EXECUTE FUNCTION refuse_doomed();
      `);
    });
    afterAll(async () => {
      await testDb.db.pool.query(
        "DROP TRIGGER refuse_doomed ON messages; DROP FUNCTION refuse_doomed();",
      );
    });

    it("answers 500 internal_error instead of pretending the answer is still coming", async () => {
      fake = new FakeLlmProvider().script({ deltas: ["Doomed"] });
      app = makeTestApp({ db: testDb.db, ...testProviders({ llm: fake }) });
      const session = await createSession(app);

      const response = await send(app, session.id, { content: "Hi" });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: "internal_error" });
    });
  });

  it("refuses a send once shutdown began with 503 server_busy, before writing anything", async () => {
    fake = new FakeLlmProvider().script({ hang: true });
    const jobs = createJobRegistry({ db: testDb.db, flushIntervalMs: 50, log: Fastify().log });
    app = makeTestApp({ db: testDb.db, jobs, ...testProviders({ llm: fake }) });
    const session = await createSession(app);
    await jobs.shutdown(1_000);

    const response = await send(app, session.id, { content: "Late" });

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("10");
    expect(response.json()).toMatchObject({ status: 503, code: "server_busy" });
    expect(await allMessages(app, session.id)).toEqual([]);
    expect(fake.requests).toEqual([]);
    expect((await getSession(app, session.id)).title).toBeNull();
  });

  it("stores an answer that finished just before shutdown aborted its job", async () => {
    const jobs = createJobRegistry({ db: testDb.db, flushIntervalMs: 50, log: Fastify().log });
    const finishesThenShutsDown: LlmProvider = {
      id: "late",
      async *stream() {
        yield { type: "delta", text: "Complete answer" };
        yield { type: "finish", reason: "stop", usage: null };
        // The job has its finish event; shutdown now aborts it before the terminal write.
        void jobs.shutdown(1_000);
      },
    };
    app = makeTestApp({ db: testDb.db, jobs, ...testProviders({ llm: finishesThenShutsDown }) });
    const session = await createSession(app);

    const response = await send(app, session.id, { content: "Hi" });

    expect(response.statusCode).toBe(200);
    expect(response.json().assistantMessage).toMatchObject({
      status: "completed",
      content: "Complete answer",
    });
  });
});
