import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { TEST_ENV, makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider, createGate } from "../helpers/fake-llm.js";
import { allMessages, createSession, eventually, send } from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";

const testDb = useTestDatabase();

describe("context sent to the provider", () => {
  let app: FastifyInstance;
  let fake: FakeLlmProvider;

  function start(env: Record<string, string> = {}): void {
    fake = new FakeLlmProvider();
    app = makeTestApp({
      db: testDb.db,
      config: loadConfig({ ...TEST_ENV, ...env }),
      ...testProviders({ llm: fake }),
    });
  }

  afterEach(async () => {
    await app.close();
  });

  it("is the system prompt, earlier completed turns, then the new message; failed turns are left out", async () => {
    start();
    fake.script({ deltas: ["A1"] }, { deltas: ["partial"], throwAfter: 1 }, { deltas: ["A3"] });
    const session = await createSession(app, { systemPrompt: "Be brief." });
    expect((await send(app, session.id, { content: "Q1" })).statusCode).toBe(200);
    expect((await send(app, session.id, { content: "Q2" })).statusCode).toBe(502);

    expect((await send(app, session.id, { content: "Q3" })).statusCode).toBe(200);

    expect(fake.requests[2]?.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q3" },
    ]);
  });

  it("never includes a turn still generating in another session", async () => {
    start();
    const gate = createGate();
    fake.script({ deltas: ["Secret so far"], gate: gate.promise }, { deltas: ["Fine"] });
    const elsewhere = await createSession(app);
    const pending = send(app, elsewhere.id, { content: "Secret question" });
    await eventually(
      () => allMessages(app, elsewhere.id),
      (messages) => messages[1]?.content === "Secret so far",
    );
    const session = await createSession(app);

    await send(app, session.id, { content: "Mine" });

    expect(fake.requests[1]?.messages).toEqual([{ role: "user", content: "Mine" }]);
    gate.release();
    await pending;
  });

  it("uses DEFAULT_SYSTEM_PROMPT for a session without its own system prompt", async () => {
    start({ DEFAULT_SYSTEM_PROMPT: "You are a helpful assistant." });
    const session = await createSession(app);

    await send(app, session.id, { content: "Hi" });

    expect(fake.requests[0]?.messages).toEqual([
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hi" },
    ]);
  });

  it("prefers the session's own system prompt to DEFAULT_SYSTEM_PROMPT", async () => {
    start({ DEFAULT_SYSTEM_PROMPT: "You are a helpful assistant." });
    const session = await createSession(app, { systemPrompt: "Answer in French." });

    await send(app, session.id, { content: "Hi" });

    expect(fake.requests[0]?.messages[0]).toEqual({ role: "system", content: "Answer in French." });
  });

  it("uses the settings a session has when a message is sent", async () => {
    start();
    const session = await createSession(app);
    await app.inject({
      method: "PATCH",
      url: `/sessions/${session.id}`,
      payload: { provider: "other", model: "o-large", systemPrompt: "New rules." },
    });

    const response = await send(app, session.id, { content: "Hi" });

    expect(response.json().assistantMessage).toMatchObject({ provider: "other", model: "o-large" });
    expect(fake.requests[0]).toMatchObject({
      model: "o-large",
      maxOutputTokens: 4096,
      messages: [
        { role: "system", content: "New rules." },
        { role: "user", content: "Hi" },
      ],
    });
  });
});
