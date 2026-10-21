import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider } from "../helpers/fake-llm.js";
import { type Message, createSession, getMessage, getSession, send } from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";

const testDb = useTestDatabase();

const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

describe("POST /sessions/:id/messages", () => {
  let app: FastifyInstance;
  let fake: FakeLlmProvider;

  function start(): FastifyInstance {
    fake = new FakeLlmProvider();
    app = makeTestApp({ db: testDb.db, ...testProviders({ llm: fake }) });
    return app;
  }

  afterEach(async () => {
    await app.close();
  });

  describe("send.happy", () => {
    it("answers 200 with the stored user message and the completed assistant message", async () => {
      start();
      fake.script({ deltas: ["Hel", "lo"], usage: { promptTokens: 11, completionTokens: 2 } });
      const session = await createSession(app, { provider: "other", model: "o-small" });

      const response = await send(app, session.id, { content: "Say hello" });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toMatch(/^application\/json/);
      const { userMessage, assistantMessage }: { userMessage: Message; assistantMessage: Message } =
        response.json();
      expect(userMessage).toEqual({
        id: expect.any(String),
        sessionId: session.id,
        seq: 1,
        role: "user",
        content: "Say hello",
        status: "completed",
        replyToId: null,
        attempt: null,
        errorCode: null,
        errorDetail: null,
        provider: null,
        model: null,
        usage: null,
        finishReason: null,
        latencyMs: null,
        createdAt: expect.stringMatching(ISO_MICROS),
        updatedAt: expect.stringMatching(ISO_MICROS),
      });
      expect(assistantMessage).toEqual({
        id: expect.any(String),
        sessionId: session.id,
        seq: 2,
        role: "assistant",
        content: "Hello",
        status: "completed",
        replyToId: userMessage.id,
        attempt: 1,
        errorCode: null,
        errorDetail: null,
        provider: "other",
        model: "o-small",
        usage: { promptTokens: 11, completionTokens: 2 },
        finishReason: "stop",
        latencyMs: expect.any(Number),
        createdAt: expect.stringMatching(ISO_MICROS),
        updatedAt: expect.stringMatching(ISO_MICROS),
      });
      expect(assistantMessage.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("asks the session's model for at most its catalogued output tokens", async () => {
      start();
      const session = await createSession(app, { provider: "other", model: "o-small" });

      await send(app, session.id, { content: "Say hello" });

      expect(fake.requests).toEqual([
        {
          model: "o-small",
          maxOutputTokens: 512,
          messages: [{ role: "user", content: "Say hello" }],
        },
      ]);
    });

    it("moves the session's lastActivityAt and titles an untitled session", async () => {
      start();
      const session = await createSession(app);

      await send(app, session.id, { content: "Plan a trip to Kyoto" });

      const after = await getSession(app, session.id);
      expect(after.lastActivityAt > session.lastActivityAt).toBe(true);
      expect(after.title).toBe("Plan a trip to Kyoto");
      // The derived title changed the session.
      expect(after.updatedAt > session.updatedAt).toBe(true);
    });

    it("stores usage as null when the provider reports none", async () => {
      start();
      fake.script({ usage: null, finishReason: "length" });
      const session = await createSession(app);

      const response = await send(app, session.id, { content: "Hi" });

      expect(response.json().assistantMessage).toMatchObject({
        usage: null,
        finishReason: "length",
      });
    });

    it("keeps the answer readable afterwards through GET …/messages/:mid", async () => {
      start();
      const session = await createSession(app);
      const { userMessage, assistantMessage } = (
        await send(app, session.id, { content: "Hi" })
      ).json();

      const user = await getMessage(app, session.id, userMessage.id);
      const assistant = await getMessage(app, session.id, assistantMessage.id);

      expect(user.statusCode).toBe(200);
      expect(user.json()).toEqual(userMessage);
      expect(assistant.json()).toEqual(assistantMessage);
    });

    it("answers 404 session_not_found for an unknown session and writes nothing", async () => {
      start();

      const response = await send(app, "0190f5a0-0000-7000-8000-000000000000", {
        content: "Hi",
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "session_not_found" });
      expect(fake.requests).toEqual([]);
    });
  });
});
