import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { TEST_ENV, makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider, createGate } from "../helpers/fake-llm.js";
import { type Message, allMessages, createSession, send } from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";

const testDb = useTestDatabase();

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type TurnBody = { userMessage: Message; assistantMessage: Message };

describe("idempotent send: client message ids", () => {
  let app: FastifyInstance;
  let fake: FakeLlmProvider;
  /** Gates still closed at the end of a test; opened so that closing the app is quick. */
  const gates: Array<() => void> = [];

  function start(env: Record<string, string> = {}): FastifyInstance {
    fake = new FakeLlmProvider();
    app = makeTestApp({
      db: testDb.db,
      config: loadConfig({ ...TEST_ENV, ...env }),
      ...testProviders({ llm: fake }),
    });
    return app;
  }

  /** The next generation emits `gateAfter` of its chunks, then holds until released. */
  function holdGeneration(deltas: readonly string[] = ["Hel", "lo"], gateAfter?: number) {
    const gate = createGate();
    gates.push(gate.release);
    fake.script({ deltas, gate: gate.promise, ...(gateAfter === undefined ? {} : { gateAfter }) });
    return gate.release;
  }

  afterEach(async () => {
    for (const release of gates.splice(0)) {
      release();
    }
    await app.close();
  });

  describe("replay.id", () => {
    it("generates a UUIDv7 user message id when none is sent, and does not deduplicate identical sends", async () => {
      start();
      const session = await createSession(app);

      const first = await send(app, session.id, { content: "Hi" });
      const second = await send(app, session.id, { content: "Hi" });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      const firstTurn: TurnBody = first.json();
      const secondTurn: TurnBody = second.json();
      expect(firstTurn.userMessage.id).toMatch(UUID_V7);
      expect(secondTurn.userMessage.id).toMatch(UUID_V7);
      expect(secondTurn.userMessage.id).not.toBe(firstTurn.userMessage.id);
      expect(await allMessages(app, session.id)).toHaveLength(4);
      expect(fake.requests).toHaveLength(2);
    });

    it("stores the client's id as the user message id, any UUID version", async () => {
      start();
      const session = await createSession(app);
      const id = "6f1c2b9e-3d4a-4c5b-9e8f-0a1b2c3d4e5f";

      const response = await send(app, session.id, { id, content: "Hi" });

      expect(response.statusCode).toBe(200);
      const { userMessage, assistantMessage }: TurnBody = response.json();
      expect(userMessage).toMatchObject({ id, content: "Hi", role: "user" });
      expect(assistantMessage).toMatchObject({ replyToId: id, status: "completed" });
    });

    it.each([["not a uuid"], [""], [42], ["6f1c2b9e3d4a4c5b9e8f0a1b2c3d4e5f"]])(
      "rejects the id %j with 400 validation_error and writes nothing",
      async (id) => {
        start();
        const session = await createSession(app);

        const response = await send(app, session.id, { id, content: "Hi" });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ code: "validation_error" });
        expect(await allMessages(app, session.id)).toEqual([]);
        expect(fake.requests).toHaveLength(0);
      },
    );
  });

  describe("replay.completed", () => {
    it.each([[{}], [{ prefer: "respond-async" }]])(
      "answers a repeated send of a completed turn with 200 and the same turn, admitting nothing (headers %j)",
      async (headers) => {
        start();
        const session = await createSession(app);
        const payload = { id: crypto.randomUUID(), content: "Hi" };
        const original = await send(app, session.id, payload);
        expect(original.statusCode).toBe(200);
        const sessionBefore = (await app.inject({ url: `/sessions/${session.id}` })).json();

        const replay = await send(app, session.id, payload, headers);

        expect(replay.statusCode).toBe(200);
        expect(replay.headers.vary).toBe("Accept");
        expect(replay.json()).toEqual(original.json());
        expect((replay.json() as TurnBody).assistantMessage).toMatchObject({
          status: "completed",
          content: "Hello",
        });
        expect(fake.requests).toHaveLength(1);
        expect(await allMessages(app, session.id)).toHaveLength(2);
        // A replay writes nothing: not even the session's activity time.
        expect((await app.inject({ url: `/sessions/${session.id}` })).json()).toEqual(
          sessionBefore,
        );
      },
    );

    it("answers a repeated send of a failed turn with 502 and both stored messages, also with respond-async", async () => {
      start();
      fake.script({ deltas: ["Hel", "lo"], throwAfter: 1 });
      const session = await createSession(app);
      const payload = { id: crypto.randomUUID(), content: "Hi" };
      const original = await send(app, session.id, payload);
      expect(original.statusCode).toBe(502);

      const replay = await send(app, session.id, payload, { prefer: "respond-async" });

      expect(replay.statusCode).toBe(502);
      expect(replay.headers["content-type"]).toMatch(/^application\/problem\+json/);
      expect(replay.headers["preference-applied"]).toBe("respond-async");
      expect(replay.json()).toEqual(original.json());
      expect(replay.json()).toMatchObject({
        code: "llm_upstream_error",
        userMessage: { id: payload.id },
        assistantMessage: { status: "failed", content: "Hel" },
      });
      expect(fake.requests).toHaveLength(1);
      expect(await allMessages(app, session.id)).toHaveLength(2);
    });

    it("replays an earlier turn after a later one, without a new turn", async () => {
      start();
      const session = await createSession(app);
      const first = { id: crypto.randomUUID(), content: "First" };
      const original = await send(app, session.id, first);
      await send(app, session.id, { content: "Second" });

      const replay = await send(app, session.id, first);

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(original.json());
      expect(await allMessages(app, session.id)).toHaveLength(4);
      expect(fake.requests).toHaveLength(2);
    });
  });
});
