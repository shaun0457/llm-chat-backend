import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { LlmProvider } from "../../src/llm/port.js";
import { makeTestApp, testJobs } from "../helpers/app.js";
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

  it("refuses a send once shutdown began with 503 server_busy, before writing anything", async () => {
    fake = new FakeLlmProvider().script({ hang: true });
    const jobs = testJobs(testDb.db);
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
    const jobs = testJobs(testDb.db);
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
