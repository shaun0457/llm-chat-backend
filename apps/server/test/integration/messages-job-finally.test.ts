import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { createJobRegistry } from "../../src/modules/messages/jobs.js";
import { makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider, createGate } from "../helpers/fake-llm.js";
import { allMessages, createSession, eventually, send } from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";

const testDb = useTestDatabase();

describe("job.finally", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("completes many sequential turns in one process and still admits the next", async () => {
    // The real demo provider (DEMO_DELAY_MS=1 in tests).
    const demoApp = makeTestApp({ db: testDb.db });
    app = demoApp;
    const session = await createSession(demoApp);

    for (let turn = 1; turn <= 20; turn += 1) {
      const response = await send(demoApp, session.id, { content: `Turn ${turn}` });
      expect(response.statusCode).toBe(200);
    }
    const next = await send(demoApp, session.id, { content: "One more" });

    expect(next.statusCode).toBe(200);
    const messages = await allMessages(demoApp, session.id);
    expect(messages).toHaveLength(42);
    expect(messages.every((message) => message.status === "completed")).toBe(true);
  });

  it("finishes the turn although a stream subscriber throws; other subscribers still hear it", async () => {
    const fake = new FakeLlmProvider();
    const gate = createGate();
    fake.script({ deltas: ["Hel", "lo"], gate: gate.promise, gateAfter: 1 });
    const jobs = createJobRegistry({ db: testDb.db, flushIntervalMs: 50, log: Fastify().log });
    const fakeApp = makeTestApp({ db: testDb.db, jobs, ...testProviders({ llm: fake }) });
    app = fakeApp;
    const session = await createSession(fakeApp);
    const pending = send(fakeApp, session.id, { content: "Hi" });
    const [, assistant] = await eventually(
      () => allMessages(fakeApp, session.id),
      (messages) => messages.length === 2,
    );
    const job = jobs.get(assistant?.id ?? "");
    if (job === undefined) {
      throw new Error("expected the generation to be running");
    }
    const heard: string[] = [];

    job.bus.subscribe(() => {
      throw new Error("a broken subscriber");
    });
    job.bus.subscribe((event) => heard.push(event.type));
    gate.release();

    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(response.json().assistantMessage).toMatchObject({
      status: "completed",
      content: "Hello",
    });
    expect(heard).toEqual(["delta", "terminal"]);
  });

  it("shuts down while a generation hangs: the generation is aborted and the waiting send answers", async () => {
    const fake = new FakeLlmProvider();
    fake.script({ deltas: ["Hel"], hang: true });
    const fakeApp = makeTestApp({ db: testDb.db, ...testProviders({ llm: fake }) });
    const session = await createSession(fakeApp);
    const pending = send(fakeApp, session.id, { content: "Hi" });
    await eventually(
      () => allMessages(fakeApp, session.id),
      (messages) => messages.length === 2,
    );

    await fakeApp.close();

    expect(fake.signals[0]?.aborted).toBe(true);
    const response = await pending;
    expect(response.statusCode).toBe(202);
    expect(response.json().assistantMessage).toMatchObject({ status: "generating" });
  });
});
