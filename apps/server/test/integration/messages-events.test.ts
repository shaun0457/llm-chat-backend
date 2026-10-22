import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { TEST_ENV, makeTestApp } from "../helpers/app.js";
import { insertCrashedTurn } from "../helpers/crash.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider, createGate } from "../helpers/fake-llm.js";
import { type Message, createSession, eventually, getMessage, send } from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";
import {
  type SseEvent,
  closeListeningApp,
  eventsOf,
  listen,
  openSse,
  parseSse,
} from "../helpers/sse-client.js";

const testDb = useTestDatabase();

/** Older than the default stale threshold (180 + 10 + 50 = 240 s). */
const STALE_SECONDS = 300;
/** Well within it. */
const YOUNG_SECONDS = 10;

type TurnBody = { userMessage: Message; assistantMessage: Message };

describe("re-attaching with the events endpoint", () => {
  let app: FastifyInstance;
  let fake: FakeLlmProvider;
  const gates: Array<() => void> = [];

  function start(): FastifyInstance {
    fake = new FakeLlmProvider();
    app = makeTestApp({
      db: testDb.db,
      config: loadConfig(TEST_ENV),
      ...testProviders({ llm: fake }),
    });
    return app;
  }

  function holdGeneration(deltas: readonly string[], gateAfter: number): () => void {
    const gate = createGate();
    gates.push(gate.release);
    fake.script({ deltas, gate: gate.promise, gateAfter });
    return gate.release;
  }

  /** A JSON send that answers at once (202 while generating). */
  async function sendAsync(sessionId: string, content = "Hi"): Promise<TurnBody> {
    const response = await send(app, sessionId, { content }, { prefer: "respond-async" });
    expect(response.statusCode).toBe(202);
    return response.json();
  }

  const eventsUrl = (sessionId: string, messageId: string): string =>
    `/sessions/${sessionId}/messages/${messageId}/events`;

  /** The events endpoint through inject(), which returns the whole stream once it ended (V2). */
  async function injectEvents(sessionId: string, messageId: string) {
    const response = await app.inject({ method: "GET", url: eventsUrl(sessionId, messageId) });
    return {
      response,
      events: (): SseEvent[] => eventsOf(parseSse(response.body)),
    };
  }

  afterEach(async () => {
    for (const release of gates.splice(0)) {
      release();
    }
    await closeListeningApp(app);
  });

  describe("events.live", () => {
    it("sends the text so far as the snapshot, then only the remaining deltas, then done", async () => {
      start();
      const release = holdGeneration(["a", "b", "c", "d"], 2);
      const session = await createSession(app);
      const { assistantMessage } = await sendAsync(session.id);
      // Flushed only once the generation has emitted it: the first two chunks are out.
      await eventually(
        () => getMessage(app, session.id, assistantMessage.id),
        (response) => response.json().content === "ab",
      );
      const base = await listen(app);

      const stream = await openSse(`${base}${eventsUrl(session.id, assistantMessage.id)}`);
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      const created = await stream.nextEvent();
      release();
      const { frames, error } = await stream.drain();

      expect(error).toBeUndefined();
      expect(created?.event).toBe("message.created");
      const snapshot = (created?.data as TurnBody).assistantMessage;
      expect(snapshot).toMatchObject({
        id: assistantMessage.id,
        status: "generating",
        content: "ab",
      });
      const events = eventsOf(frames);
      expect(events.map(({ event }) => event)).toEqual(["delta", "delta", "done"]);
      expect(events.slice(0, 2).map(({ data }) => data)).toEqual([
        { id: assistantMessage.id, attempt: 1, text: "c" },
        { id: assistantMessage.id, attempt: 1, text: "d" },
      ]);
      const done = (events[2]?.data as { assistantMessage: Message }).assistantMessage;
      expect(done).toMatchObject({ status: "completed", content: "abcd" });
    });
  });

  describe("events.after-202", () => {
    it("lets a JSON client that got 202 follow the same generation to done via Location", async () => {
      start();
      const release = holdGeneration(["Hel", "lo"], 0);
      const session = await createSession(app);
      const response = await send(app, session.id, { content: "Hi" }, { prefer: "respond-async" });
      expect(response.statusCode).toBe(202);
      const base = await listen(app);

      const stream = await openSse(`${base}${String(response.headers.location)}/events`);
      const created = await stream.nextEvent();
      release();
      const { frames, error } = await stream.drain();

      expect(error).toBeUndefined();
      const snapshot = (created?.data as TurnBody).assistantMessage;
      const events = eventsOf(frames);
      const deltas = events.filter(({ event }) => event === "delta");
      expect(
        snapshot.content + deltas.map(({ data }) => (data as { text: string }).text).join(""),
      ).toBe("Hello");
      expect(events.at(-1)?.event).toBe("done");
      expect((events.at(-1)?.data as { assistantMessage: Message }).assistantMessage).toMatchObject(
        {
          id: snapshot.id,
          status: "completed",
          content: "Hello",
        },
      );
    });
  });

  describe("events.terminal", () => {
    it("sends message.created and done for a completed message, then ends (inject returns the whole stream, V2)", async () => {
      start();
      const session = await createSession(app);
      const sent = await send(app, session.id, { content: "Hi" }, { prefer: "wait=5" });
      expect(sent.statusCode).toBe(200);
      const turn: TurnBody = sent.json();

      const { response, events } = await injectEvents(session.id, turn.assistantMessage.id);

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
      expect(response.headers["cache-control"]).toBe("no-cache, no-transform");
      expect(events().map(({ event, data }) => ({ event, data }))).toEqual([
        { event: "message.created", data: turn },
        { event: "done", data: { assistantMessage: turn.assistantMessage } },
      ]);
    });

    it("sends message.created and error for a failed message", async () => {
      start();
      fake.script({ deltas: ["par", "x"], throwAfter: 1 });
      const session = await createSession(app);
      const sent = await send(app, session.id, { content: "Hi" }, { prefer: "wait=5" });
      expect(sent.statusCode).toBe(502);
      const { assistantMessage } = sent.json() as TurnBody;

      const { events } = await injectEvents(session.id, assistantMessage.id);

      expect(events().map(({ event }) => event)).toEqual(["message.created", "error"]);
      expect(events()[1]?.data).toEqual({
        code: "llm_upstream_error",
        detail: assistantMessage.errorDetail,
        assistantMessage,
      });
    });

    it("is 404 for a message of another session, a user message, an unknown id and an unknown session", async () => {
      start();
      const session = await createSession(app);
      const other = await createSession(app);
      const sent = await send(app, session.id, { content: "Hi" }, { prefer: "wait=5" });
      const { userMessage, assistantMessage }: TurnBody = sent.json();
      const unknownId = "0190f5a0-0000-7000-8000-00000000dead";

      const foreign = await injectEvents(other.id, assistantMessage.id);
      const user = await injectEvents(session.id, userMessage.id);
      const unknown = await injectEvents(session.id, unknownId);
      const noSession = await injectEvents(unknownId, assistantMessage.id);

      for (const { response } of [foreign, user, unknown]) {
        expect(response.statusCode).toBe(404);
        expect(response.headers["content-type"]).toContain("application/problem+json");
        expect(response.json()).toMatchObject({ code: "message_not_found" });
      }
      expect(noSession.response.statusCode).toBe(404);
      expect(noSession.response.headers["content-type"]).toContain("application/problem+json");
      expect(noSession.response.json()).toMatchObject({ code: "session_not_found" });
    });
  });

  describe("events.fallback", () => {
    it("sends message.detached for a young generating row that no job here is generating", async () => {
      start();
      const session = await createSession(app);
      const { assistantId } = await insertCrashedTurn(testDb.db, session.id, YOUNG_SECONDS);

      const { response, events } = await injectEvents(session.id, assistantId);

      expect(response.statusCode).toBe(200);
      expect(events().map(({ event }) => event)).toEqual(["message.created", "message.detached"]);
      expect(events()[1]?.data).toEqual({
        assistantMessage: expect.objectContaining({
          id: assistantId,
          status: "generating",
          content: "Half an answer",
        }),
      });
    });

    it("reclaims a stale generating row first and then reports it as failed / interrupted", async () => {
      start();
      const session = await createSession(app);
      const { assistantId } = await insertCrashedTurn(testDb.db, session.id, STALE_SECONDS);

      const { events } = await injectEvents(session.id, assistantId);

      expect(events().map(({ event }) => event)).toEqual(["message.created", "error"]);
      const created = events()[0]?.data as TurnBody;
      expect(created.assistantMessage).toMatchObject({
        status: "failed",
        errorCode: "interrupted",
      });
      expect(events()[1]?.data).toEqual({
        code: "interrupted",
        detail: expect.any(String),
        assistantMessage: expect.objectContaining({
          id: assistantId,
          status: "failed",
          errorCode: "interrupted",
          content: "Half an answer",
        }),
      });
    });
  });
});
