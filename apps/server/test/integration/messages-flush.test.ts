import type { FastifyInstance } from "fastify";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

import { makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider, createGate } from "../helpers/fake-llm.js";
import {
  type Message,
  allMessages,
  createSession,
  eventually,
  getMessage,
  send,
} from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";

const testDb = useTestDatabase();

/** TEST_ENV flushes every 50 ms; waiting this long gives a stray writer many chances. */
const SEVERAL_FLUSH_INTERVALS_MS = 400;

describe("flush-fencing", () => {
  let app: FastifyInstance;
  let fake: FakeLlmProvider;

  afterEach(async () => {
    await app.close();
  });

  function start(): void {
    fake = new FakeLlmProvider();
    app = makeTestApp({ db: testDb.db, ...testProviders({ llm: fake }) });
  }

  /** The generating assistant message, once the turn is visible through the list. */
  async function assistantOf(sessionId: string): Promise<Message> {
    const messages = await eventually(
      () => allMessages(app, sessionId),
      (items) => items.length === 2,
    );
    const assistant = messages[1];
    if (assistant === undefined) {
      throw new Error("no assistant message");
    }
    return assistant;
  }

  const read = async (sessionId: string, id: string) => {
    const response = await getMessage(app, sessionId, id);
    return { statusCode: response.statusCode, body: response.json() };
  };

  const aborted = () =>
    eventually(
      async () => fake.signals[0]?.aborted,
      (value) => value === true,
    );

  it("makes partial content visible through GET …/:mid before the answer completes", async () => {
    start();
    const gate = createGate();
    fake.script({ deltas: ["Hel", "lo", " world"], gate: gate.promise, gateAfter: 2 });
    const session = await createSession(app);
    const pending = send(app, session.id, { content: "Hi" });
    const assistant = await assistantOf(session.id);

    const partial = await eventually(
      () => read(session.id, assistant.id),
      ({ body }) => body.content === "Hello",
    );

    expect(partial.body).toMatchObject({ status: "generating", attempt: 1, content: "Hello" });
    gate.release();
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(response.json().assistantMessage).toMatchObject({
      status: "completed",
      content: "Hello world",
    });
  });

  it("stops at the next flush once its row is deleted, and never writes it back", async () => {
    start();
    const gate = createGate();
    fake.script({ deltas: ["Hel", "lo"], gate: gate.promise, gateAfter: 1, hang: true });
    const session = await createSession(app);
    const pending = send(app, session.id, { content: "Hi" });
    const assistant = await assistantOf(session.id);
    await eventually(
      () => read(session.id, assistant.id),
      ({ body }) => body.content === "Hel",
    );

    await testDb.db.pool.query("DELETE FROM messages WHERE id = $1", [assistant.id]);
    gate.release();

    await aborted();
    const response = await pending;
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "message_not_found" });
    await sleep(SEVERAL_FLUSH_INTERVALS_MS);
    expect((await read(session.id, assistant.id)).statusCode).toBe(404);
  });

  it("stops once a newer attempt owns the row, and leaves the newer state alone", async () => {
    start();
    const gate = createGate();
    fake.script({ deltas: ["Old", " text"], gate: gate.promise, gateAfter: 1, hang: true });
    const session = await createSession(app);
    const pending = send(app, session.id, { content: "Hi" });
    const assistant = await assistantOf(session.id);
    await eventually(
      () => read(session.id, assistant.id),
      ({ body }) => body.content === "Old",
    );

    await testDb.db.pool.query("UPDATE messages SET attempt = 2, content = 'Newer' WHERE id = $1", [
      assistant.id,
    ]);
    gate.release();

    await aborted();
    const response = await pending;
    // The stale job ended without a terminal state; the row belongs to the newer attempt.
    expect(response.statusCode).toBe(202);
    await sleep(SEVERAL_FLUSH_INTERVALS_MS);
    expect((await read(session.id, assistant.id)).body).toMatchObject({
      attempt: 2,
      status: "generating",
      content: "Newer",
    });
  });
});
