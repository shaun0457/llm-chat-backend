import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { TEST_ENV, makeTestApp } from "../helpers/app.js";
import { insertCrashedTurn } from "../helpers/crash.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider, createGate } from "../helpers/fake-llm.js";
import { makeHostedTestApp } from "../helpers/hosted.js";
import {
  type Message,
  allMessages,
  createSession,
  eventually,
  getMessage,
  getSession,
  send,
} from "../helpers/messages.js";
import { streamOf, useUpstream } from "../helpers/msw-openai.js";
import { testProviders } from "../helpers/providers.js";
import { closeListeningApp, eventsOf, listen, openSse, parseSse } from "../helpers/sse-client.js";

const testDb = useTestDatabase();
const upstream = useUpstream();

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEADER_KEY = "replay-key-not-real-0010";
const SSE = { accept: "text/event-stream" };

type TurnBody = { userMessage: Message; assistantMessage: Message };

describe("idempotent send: client message ids", () => {
  let app: FastifyInstance;
  let fake: FakeLlmProvider;
  /** Gates still closed at the end of a test; opened so that closing the app is quick. */
  const gates: Array<() => void> = [];
  /** Requests still running at the end of a test; settled before the app closes. */
  const pending: Array<Promise<LightMyRequestResponse>> = [];

  function start(
    env: Record<string, string> = {},
    options: { operatorKeys?: Record<string, string> } = {},
  ): FastifyInstance {
    fake = new FakeLlmProvider();
    app = makeTestApp({
      db: testDb.db,
      config: loadConfig({ ...TEST_ENV, ...env }),
      ...options,
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
    await Promise.allSettled(pending.splice(0));
    await closeListeningApp(app);
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

    it("treats an id in upper case as the same id and returns it in lower case", async () => {
      start();
      const session = await createSession(app);
      const id = "6F1C2B9E-3D4A-4C5B-9E8F-0A1B2C3D4E60";

      const original = await send(app, session.id, { id, content: "Hi" });
      const replay = await send(app, session.id, { id: id.toLowerCase(), content: "Hi" });

      expect(original.statusCode).toBe(200);
      expect((original.json() as TurnBody).userMessage.id).toBe(id.toLowerCase());
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(original.json());
      expect(fake.requests).toHaveLength(1);
    });

    it("replays a send made through the session path in upper case, with 200 and the same turn", async () => {
      start();
      const session = await createSession(app);
      const upperSessionId = session.id.toUpperCase();
      expect(upperSessionId).not.toBe(session.id);
      const payload = { id: crypto.randomUUID(), content: "Hi" };
      const original = await send(app, upperSessionId, payload);
      expect(original.statusCode).toBe(200);

      const replay = await send(app, upperSessionId, payload);

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(original.json());
      expect((replay.json() as TurnBody).userMessage.sessionId).toBe(session.id);
      expect(fake.requests).toHaveLength(1);
      expect(await allMessages(app, session.id)).toHaveLength(2);
    });

    it.each([
      ["not a uuid"],
      [""],
      [42],
      ["6f1c2b9e3d4a4c5b9e8f0a1b2c3d4e5f"],
      ["00000000-0000-0000-0000-000000000000"],
      ["ffffffff-ffff-ffff-ffff-ffffffffffff"],
    ])("rejects the id %j with 400 validation_error and writes nothing", async (id) => {
      start();
      const session = await createSession(app);

      const response = await send(app, session.id, { id, content: "Hi" });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "validation_error" });
      expect(await allMessages(app, session.id)).toEqual([]);
      expect(fake.requests).toHaveLength(0);
    });
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

  describe("replay.completed (event stream)", () => {
    it("streams message.created and done for a repeated send of a completed turn, like a re-attach", async () => {
      start();
      const session = await createSession(app);
      const payload = { id: crypto.randomUUID(), content: "Hi" };
      const original: TurnBody = (await send(app, session.id, payload)).json();

      const replay = await send(app, session.id, payload, SSE);

      expect(replay.statusCode).toBe(200);
      expect(replay.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
      expect(replay.headers.vary).toBe("Accept");
      const events = eventsOf(parseSse(replay.body));
      expect(events.map(({ event }) => event)).toEqual(["message.created", "done"]);
      expect(events[0]?.data).toEqual(original);
      expect(events[1]?.data).toEqual({ assistantMessage: original.assistantMessage });
      expect(fake.requests).toHaveLength(1);
      expect(await allMessages(app, session.id)).toHaveLength(2);
    });

    it("streams message.created and error for a repeated send of a failed turn", async () => {
      start();
      fake.script({ deltas: ["Hel", "lo"], throwAfter: 1 });
      const session = await createSession(app);
      const payload = { id: crypto.randomUUID(), content: "Hi" };
      expect((await send(app, session.id, payload)).statusCode).toBe(502);

      const replay = await send(app, session.id, payload, SSE);

      expect(replay.statusCode).toBe(200);
      const events = eventsOf(parseSse(replay.body));
      expect(events.map(({ event }) => event)).toEqual(["message.created", "error"]);
      expect(events[1]?.data).toMatchObject({
        code: "llm_upstream_error",
        assistantMessage: { status: "failed", content: "Hel" },
      });
      expect(fake.requests).toHaveLength(1);
    });
  });

  describe("replay.generating", () => {
    it("answers a repeated send of a turn still being generated with 202 and the same turn, never 409", async () => {
      start({ JSON_DEFAULT_WAIT_MS: "200" });
      holdGeneration();
      const session = await createSession(app);
      const payload = { id: crypto.randomUUID(), content: "Hi" };
      const original = await send(app, session.id, payload, { prefer: "respond-async" });
      expect(original.statusCode).toBe(202);
      const { userMessage, assistantMessage }: TurnBody = original.json();

      const modes: Array<Record<string, string>> = [{ prefer: "respond-async" }, {}];
      for (const headers of modes) {
        const replay = await send(app, session.id, payload, headers);

        expect(replay.statusCode).toBe(202);
        expect(replay.headers.location).toBe(
          `/sessions/${session.id}/messages/${assistantMessage.id}`,
        );
        expect(replay.headers["retry-after"]).toBe("2");
        expect(replay.headers["cache-control"]).toBe("no-store");
        expect(replay.headers.vary).toBe("Accept");
        const turn: TurnBody = replay.json();
        expect(turn.userMessage).toEqual(userMessage);
        expect(turn.assistantMessage).toMatchObject({
          id: assistantMessage.id,
          status: "generating",
          attempt: 1,
        });
      }
      expect(fake.requests).toHaveLength(1);
      expect(await allMessages(app, session.id)).toHaveLength(2);
    });

    it("answers with the outcome when the turn ends within the replay's wait", async () => {
      start();
      const release = holdGeneration();
      const session = await createSession(app);
      const payload = { id: crypto.randomUUID(), content: "Hi" };
      const original = await send(app, session.id, payload, { prefer: "respond-async" });
      expect(original.statusCode).toBe(202);

      const replay = send(app, session.id, payload, { prefer: "wait=5" });
      pending.push(replay);
      // Let the replay reach its wait, then let the answer finish.
      await new Promise((resolve) => setTimeout(resolve, 100));
      release();

      const response = await replay;
      expect(response.statusCode).toBe(200);
      expect(response.headers["preference-applied"]).toBe("wait=5");
      expect((response.json() as TurnBody).assistantMessage).toMatchObject({
        status: "completed",
        content: "Hello",
      });
      expect(fake.requests).toHaveLength(1);
    });

    it("streams the snapshot, then the remaining deltas without gap or duplicate, then done", async () => {
      start();
      const release = holdGeneration(["Hel", "lo", " there"], 1);
      const session = await createSession(app);
      const base = await listen(app);
      const payload = { id: crypto.randomUUID(), content: "Hi" };
      const original = await send(app, session.id, payload, { prefer: "respond-async" });
      expect(original.statusCode).toBe(202);
      const { userMessage, assistantMessage }: TurnBody = original.json();
      // The first chunk is generated and flushed; the rest waits at the gate.
      await eventually(
        async () => (await getMessage(app, session.id, assistantMessage.id)).json().content,
        (content) => content === "Hel",
      );

      const stream = await openSse(`${base}/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { ...SSE, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(stream.status).toBe(200);
      expect(stream.headers.get("vary")).toBe("Accept");
      const created = await stream.nextEvent();
      expect(created?.event).toBe("message.created");
      expect(created?.data).toEqual({
        userMessage,
        assistantMessage: expect.objectContaining({
          id: assistantMessage.id,
          status: "generating",
          content: "Hel",
        }),
      });
      release();
      const { frames, error } = await stream.drain();
      expect(error).toBeUndefined();
      const events = eventsOf(frames);
      expect(events.map(({ event }) => event)).toEqual(["delta", "delta", "done"]);
      expect(events.slice(0, 2).map(({ data }) => data)).toEqual([
        { id: assistantMessage.id, attempt: 1, text: "lo" },
        { id: assistantMessage.id, attempt: 1, text: " there" },
      ]);
      expect(events[2]?.data).toEqual({
        assistantMessage: expect.objectContaining({ status: "completed", content: "Hello there" }),
      });
      expect(fake.requests).toHaveLength(1);
    });
  });

  describe("replay.reclaimed", () => {
    it("fails a crashed turn as interrupted first, then replays it as 502 or an error event", async () => {
      start();
      const session = await createSession(app);
      // Older than the stale threshold (240 s by default): no job can still be behind it.
      const { userId, assistantId } = await insertCrashedTurn(testDb.db, session.id, 600);
      const payload = { id: userId, content: "Hi" };

      const json = await send(app, session.id, payload, { prefer: "respond-async" });
      const streamed = await send(app, session.id, payload, SSE);

      expect(json.statusCode).toBe(502);
      expect(json.json()).toMatchObject({
        code: "interrupted",
        assistantMessage: { id: assistantId, status: "failed", content: "Half an answer" },
      });
      const events = eventsOf(parseSse(streamed.body));
      expect(events.map(({ event }) => event)).toEqual(["message.created", "error"]);
      expect(events[1]?.data).toMatchObject({ code: "interrupted" });
      expect(fake.requests).toHaveLength(0);
    });

    it("answers 202 or message.detached for a turn generating where this process cannot follow it", async () => {
      start();
      const session = await createSession(app);
      // Younger than the stale threshold, and no job in this process.
      const { userId, assistantId } = await insertCrashedTurn(testDb.db, session.id, 1);
      const payload = { id: userId, content: "Hi" };

      const json = await send(app, session.id, payload, { prefer: "respond-async" });
      const streamed = await send(app, session.id, payload, SSE);

      expect(json.statusCode).toBe(202);
      expect((json.json() as TurnBody).assistantMessage).toMatchObject({
        id: assistantId,
        status: "generating",
      });
      const events = eventsOf(parseSse(streamed.body));
      expect(events.map(({ event }) => event)).toEqual(["message.created", "message.detached"]);
      expect(fake.requests).toHaveLength(0);
    });
  });

  describe("replay.skips-checks", () => {
    it("replays without the API key the original send needed (hosted provider)", async () => {
      app = makeHostedTestApp({ db: testDb.db });
      upstream.reply(streamOf([{ content: "Hello" }, { finishReason: "stop" }]));
      const session = await createSession(app, { provider: "nvidia" });
      const payload = { id: crypto.randomUUID(), content: "Hi" };
      const original = await send(app, session.id, payload, { "x-llm-api-key": HEADER_KEY });
      expect(original.statusCode).toBe(200);
      expect(upstream.requests).toHaveLength(1);

      const replay = await send(app, session.id, payload);

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(original.json());
      expect(upstream.requests).toHaveLength(1);
    });

    it("replays the stored turn after the session's provider and model changed", async () => {
      start({}, { operatorKeys: {} });
      const session = await createSession(app);
      const payload = { id: crypto.randomUUID(), content: "Hi" };
      const original = await send(app, session.id, payload);
      expect(original.statusCode).toBe(200);
      // The new defaults name another model, of a provider that needs a key the server lacks.
      const patched = await app.inject({
        method: "PATCH",
        url: `/sessions/${session.id}`,
        payload: { provider: "other", model: "o-small" },
      });
      expect(patched.statusCode).toBe(200);

      const omitted = await send(app, session.id, payload);
      const named = await send(app, session.id, { ...payload, provider: "demo", model: "demo" });

      for (const replay of [omitted, named]) {
        expect(replay.statusCode).toBe(200);
        expect(replay.json()).toEqual(original.json());
      }
      expect(fake.requests).toHaveLength(1);
      expect(await allMessages(app, session.id)).toHaveLength(2);
    });

    it("replays while the server is at its capacity limit, without a 503", async () => {
      start({ MAX_ACTIVE_GENERATIONS: "1" });
      const session = await createSession(app);
      const payload = { id: crypto.randomUUID(), content: "Hi" };
      const original = await send(app, session.id, payload);
      expect(original.statusCode).toBe(200);
      holdGeneration();
      const busy = await createSession(app);
      const holding = await send(app, busy.id, { content: "Hold" }, { prefer: "respond-async" });
      expect(holding.statusCode).toBe(202);
      const refused = await send(app, (await createSession(app)).id, { content: "Third" });
      expect(refused.statusCode).toBe(503);

      const replay = await send(app, session.id, payload);
      const streamed = await send(app, session.id, payload, SSE);

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(original.json());
      expect(streamed.statusCode).toBe(200);
      expect(eventsOf(parseSse(streamed.body)).map(({ event }) => event)).toEqual([
        "message.created",
        "done",
      ]);
    });
  });

  describe("replay.conflict", () => {
    const STORED = "the stored question, never echoed";

    /** A completed turn sent with a client id; returns its session and the turn. */
    async function storedTurn(payload: Record<string, unknown> = {}) {
      const created = await createSession(app);
      const id = crypto.randomUUID();
      const response = await send(app, created.id, { id, content: STORED, ...payload });
      expect(response.statusCode).toBe(200);
      return { session: await getSession(app, created.id), id, turn: response.json() as TurnBody };
    }

    function expectConflict(response: LightMyRequestResponse, detail: string): void {
      expect(response.statusCode).toBe(422);
      expect(response.headers["content-type"]).toMatch(/^application\/problem\+json/);
      expect(response.headers.vary).toBe("Accept");
      expect(response.json()).toMatchObject({ status: 422, code: "message_id_conflict", detail });
      expect(response.body).not.toContain(STORED);
    }

    it("rejects the same id with different content in the same session, writing nothing", async () => {
      start();
      const { session, id } = await storedTurn();

      const response = await send(app, session.id, { id, content: "Something else" });

      expectConflict(response, "The content differs from the stored message with this id");
      expect(await allMessages(app, session.id)).toHaveLength(2);
      expect(await getSession(app, session.id)).toEqual(session);
      expect(fake.requests).toHaveLength(1);
    });

    it("rejects content that differs only in a trailing newline (exact comparison)", async () => {
      start();
      const { session, id } = await storedTurn();

      const response = await send(app, session.id, { id, content: `${STORED}\n` });

      expectConflict(response, "The content differs from the stored message with this id");
    });

    it("rejects the same id in another session, writing nothing there", async () => {
      start();
      const { id } = await storedTurn();
      const other = await createSession(app);

      const response = await send(app, other.id, { id, content: STORED });

      expectConflict(response, "The id is already used by a message in another session");
      expect(await allMessages(app, other.id)).toEqual([]);
      expect(await getSession(app, other.id)).toEqual(other);
    });

    it.each([
      [{ model: "o-small" }, "The model differs from the one the stored turn used"],
      [{ provider: "demo" }, "The provider differs from the one the stored turn used"],
    ])(
      "rejects the same id when the request names %j, unlike the stored turn",
      async (named, detail) => {
        start();
        const { session, id } = await storedTurn({ provider: "other", model: "o-large" });

        const response = await send(app, session.id, { id, content: STORED, ...named });

        expectConflict(response, detail);
        expect(await allMessages(app, session.id)).toHaveLength(2);
        expect(fake.requests).toHaveLength(1);
      },
    );

    it("rejects the id of an assistant message", async () => {
      start();
      const { session, turn } = await storedTurn();

      const response = await send(app, session.id, {
        id: turn.assistantMessage.id,
        content: turn.assistantMessage.content,
      });

      expectConflict(response, "The id is already used by an assistant message");
      expect(await allMessages(app, session.id)).toHaveLength(2);
    });

    it("rejects a conflicting id with 422 even while the session is busy", async () => {
      start();
      const { session, id } = await storedTurn();
      holdGeneration();
      const later = await send(app, session.id, { content: "Later" }, { prefer: "respond-async" });
      expect(later.statusCode).toBe(202);

      const response = await send(app, session.id, { id, content: "Something else" });

      expectConflict(response, "The content differs from the stored message with this id");
    });
  });

  describe("replay.race", () => {
    /** Holds `count` generations at once in fresh sessions: 202 each while capacity is free. */
    async function holdInFreshSessions(count: number): Promise<number[]> {
      const sessions = [];
      for (let index = 0; index < count; index += 1) {
        holdGeneration();
        sessions.push(await createSession(app));
      }
      const responses = await Promise.all(
        sessions.map((session) =>
          send(app, session.id, { content: "Hold" }, { prefer: "respond-async" }),
        ),
      );
      return responses.map((response) => response.statusCode);
    }

    it("admits one of two concurrent sends of the same id to two sessions; the other gets 422 and leaks nothing", async () => {
      // Timing decides whether the loser collides on the primary key or already sees the
      // winner's row; the outcome must be the same either way. The next test forces the
      // collision.
      start({ MAX_ACTIVE_GENERATIONS: "2" });
      const first = await createSession(app);
      const second = await createSession(app);
      const payload = { id: crypto.randomUUID(), content: "Hi" };

      const responses = await Promise.all([
        send(app, first.id, payload),
        send(app, second.id, payload),
      ]);

      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 422]);
      const loser = responses.findIndex((response) => response.statusCode === 422);
      const [loserSession, winnerSession] = loser === 0 ? [first, second] : [second, first];
      expect(responses[loser]?.json()).toMatchObject({
        code: "message_id_conflict",
        detail: "The id is already used by a message in another session",
      });
      const winnerRows = await allMessages(app, winnerSession.id);
      expect(winnerRows.map(({ id, role }) => ({ id, role }))).toEqual([
        { id: payload.id, role: "user" },
        { id: expect.any(String), role: "assistant" },
      ]);
      expect(await allMessages(app, loserSession.id)).toEqual([]);
      expect(await getSession(app, loserSession.id)).toEqual(loserSession);
      expect(fake.requests).toHaveLength(1);
      // No reservation leaked: both slots are free again for two answers at once.
      expect(await holdInFreshSessions(2)).toEqual([202, 202]);
    });

    it("re-runs admission when its insert collides with a concurrent send of the same id, then answers 422", async () => {
      // Another transaction (as a concurrent send to another session would) has inserted the
      // id but not committed yet: this send's replay check cannot see it, and its insert waits
      // on the primary key until that transaction commits, then fails with a unique violation.
      start({ MAX_ACTIVE_GENERATIONS: "1" });
      const owner = await createSession(app);
      const target = await createSession(app);
      const id = crypto.randomUUID();
      const concurrent = new pg.Client({ connectionString: testDb.url });
      // A dropped connection then fails the test instead of crashing the worker.
      concurrent.on("error", () => {});
      try {
        await concurrent.connect();
        await concurrent.query("BEGIN");
        await concurrent.query(
          "INSERT INTO messages (id, session_id, seq, role, content, status)" +
            " VALUES ($1, $2, 1, 'user', 'Hi', 'completed')",
          [id, owner.id],
        );
        await concurrent.query(
          "INSERT INTO messages" +
            " (id, session_id, seq, role, reply_to_id, content, status, started_at, provider, model)" +
            " VALUES ($1, $2, 2, 'assistant', $3, 'Hello', 'completed', clock_timestamp(), 'demo', 'demo')",
          [crypto.randomUUID(), owner.id, id],
        );
        await concurrent.query("UPDATE sessions SET next_seq = next_seq + 2 WHERE id = $1", [
          owner.id,
        ]);

        const sent = send(app, target.id, { id, content: "Hi" });
        pending.push(sent);
        await eventually(
          async () =>
            (
              await testDb.db.pool.query<{ n: number }>(
                // The send's insert, waiting for the other transaction to end (its key).
                "SELECT count(*)::int AS n FROM pg_stat_activity" +
                  " WHERE wait_event_type = 'Lock' AND wait_event = 'transactionid'" +
                  " AND datname = current_database()" +
                  " AND query ILIKE 'insert into \"messages\"%'",
              )
            ).rows[0]?.n ?? 0,
          (waiting) => waiting > 0,
        );
        await concurrent.query("COMMIT");
        const response = await sent;

        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({
          code: "message_id_conflict",
          detail: "The id is already used by a message in another session",
        });
        expect(await allMessages(app, target.id)).toEqual([]);
        expect(await getSession(app, target.id)).toEqual(target);
        expect(fake.requests).toHaveLength(0);
        // The colliding run's reservation was released: the only slot is free.
        expect(await holdInFreshSessions(1)).toEqual([202]);
      } finally {
        // Cleanup only: after the COMMIT there is nothing to roll back.
        await concurrent.query("ROLLBACK").catch(() => {});
        await concurrent.end().catch(() => {});
      }
    });

    // Either constraint can report a taken client id, depending on the order of the inserted
    // rows: the user row's primary key, or the assistant row's reply_to_id.
    it.each(["messages_pkey", "messages_reply_to_id_unique"])(
      "re-runs admission at most twice while every insert of the id collides on %s, then answers 500 and leaks nothing",
      async (constraint) => {
        start({ MAX_ACTIVE_GENERATIONS: "1" });
        const session = await createSession(app);
        const id = crypto.randomUUID();
        const { pool } = testDb.db;
        // A boundary write: a trigger in this file's own database fails every insert of the id
        // as a concurrent send of it would, and counts the attempts (a sequence ignores
        // rollbacks).
        await pool.query("CREATE SEQUENCE test_collisions");
        await pool.query(
          "CREATE FUNCTION test_collide() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN" +
            ` IF NEW.id = '${id}' THEN PERFORM nextval('test_collisions');` +
            " RAISE EXCEPTION 'forced collision'" +
            ` USING ERRCODE = 'unique_violation', CONSTRAINT = '${constraint}'; END IF;` +
            " RETURN NEW; END $$",
        );
        await pool.query(
          "CREATE TRIGGER test_collide BEFORE INSERT ON messages" +
            " FOR EACH ROW EXECUTE FUNCTION test_collide()",
        );
        try {
          const response = await send(app, session.id, { id, content: "Hi" });

          expect(response.statusCode).toBe(500);
          expect(response.json()).toMatchObject({ code: "internal_error" });
          const { rows } = await pool.query<{ n: number }>(
            "SELECT (CASE WHEN is_called THEN last_value ELSE 0 END)::int AS n FROM test_collisions",
          );
          // The first run and two re-runs.
          expect(rows[0]?.n).toBe(3);
          expect(await allMessages(app, session.id)).toEqual([]);
          expect(await getSession(app, session.id)).toEqual(session);
          expect(fake.requests).toHaveLength(0);
          // Every run's reservation was released: the only slot is free.
          expect(await holdInFreshSessions(1)).toEqual([202]);
        } finally {
          await pool.query("DROP TRIGGER IF EXISTS test_collide ON messages");
          await pool.query("DROP FUNCTION IF EXISTS test_collide()");
          await pool.query("DROP SEQUENCE IF EXISTS test_collisions");
        }
      },
    );
  });
});
