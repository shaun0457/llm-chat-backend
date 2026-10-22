import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { TEST_ENV, makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider, createGate } from "../helpers/fake-llm.js";
import { type LogCapture, captureLogs } from "../helpers/log-capture.js";
import { type Message, createSession, eventually, getMessage, send } from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";
import {
  type SseConnection,
  closeListeningApp,
  eventsOf,
  listen,
  openSse,
} from "../helpers/sse-client.js";

const testDb = useTestDatabase();

type TurnBody = { userMessage: Message; assistantMessage: Message };

describe("SSE sends", () => {
  let app: FastifyInstance;
  let fake: FakeLlmProvider;
  let base: string;
  const gates: Array<() => void> = [];

  async function start(
    env: Record<string, string> = {},
    logStream?: NodeJS.WritableStream,
  ): Promise<void> {
    fake = new FakeLlmProvider();
    app = makeTestApp({
      db: testDb.db,
      config: loadConfig({ ...TEST_ENV, ...env }),
      ...testProviders({ llm: fake }),
      ...(logStream === undefined ? {} : { logStream }),
    });
    base = await listen(app);
  }

  /** The next generation emits `gateAfter` of its chunks, then holds until released. */
  function holdGeneration(deltas: readonly string[], gateAfter = 0): () => void {
    const gate = createGate();
    gates.push(gate.release);
    fake.script({ deltas, gate: gate.promise, gateAfter });
    return gate.release;
  }

  function streamSend(
    sessionId: string,
    content: string,
    headers: Record<string, string> = {},
  ): Promise<SseConnection> {
    return openSse(`${base}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "accept": "text/event-stream", "content-type": "application/json", ...headers },
      body: JSON.stringify({ content }),
    });
  }

  afterEach(async () => {
    for (const release of gates.splice(0)) {
      release();
    }
    await closeListeningApp(app);
  });

  describe("sse.send", () => {
    it("streams message.created, each delta with its id and attempt, then done with usage, and ends", async () => {
      await start();
      const release = holdGeneration(["Hel", "lo", " there"]);
      const session = await createSession(app);

      const stream = await streamSend(session.id, "Hi", { "x-request-id": "sse-send-1" });

      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(stream.headers.get("cache-control")).toBe("no-cache, no-transform");
      expect(stream.headers.get("x-accel-buffering")).toBe("no");
      expect(stream.headers.get("connection")).toBe("keep-alive");
      expect(stream.headers.get("content-encoding")).toBeNull();
      expect(stream.headers.get("vary")).toBe("Accept");
      // Set by an onRequest hook before the reply was hijacked (V1).
      expect(stream.headers.get("x-request-id")).toBe("sse-send-1");

      const created = await stream.nextEvent();
      expect(created?.event).toBe("message.created");
      const { userMessage, assistantMessage } = created?.data as TurnBody;
      expect(userMessage).toMatchObject({ role: "user", content: "Hi", status: "completed" });
      expect(assistantMessage).toMatchObject({
        role: "assistant",
        status: "generating",
        content: "",
        attempt: 1,
        replyToId: userMessage.id,
      });

      release();
      const { frames, error } = await stream.drain();

      expect(error).toBeUndefined();
      const events = eventsOf(frames);
      expect(events.map(({ event }) => event)).toEqual(["delta", "delta", "delta", "done"]);
      expect(events.slice(0, 3).map(({ data }) => data)).toEqual([
        { id: assistantMessage.id, attempt: 1, text: "Hel" },
        { id: assistantMessage.id, attempt: 1, text: "lo" },
        { id: assistantMessage.id, attempt: 1, text: " there" },
      ]);
      expect(events[3]?.data).toEqual({
        assistantMessage: expect.objectContaining({
          id: assistantMessage.id,
          status: "completed",
          content: "Hello there",
          usage: { promptTokens: 7, completionTokens: 2 },
          finishReason: "stop",
        }),
      });
    });

    it("is logged as a completed request, with its request id (V1)", async () => {
      const logs: LogCapture = captureLogs();
      await start({ LOG_LEVEL: "info" }, logs.stream);
      const session = await createSession(app);

      const stream = await streamSend(session.id, "Hi", { "x-request-id": "sse-send-2" });
      const { error } = await stream.drain();

      expect(error).toBeUndefined();
      const completed = logs
        .entries()
        .filter((entry) => entry.reqId === "sse-send-2" && entry.msg === "request completed");
      expect(completed).toHaveLength(1);
      expect(completed[0]?.res).toMatchObject({ statusCode: 200 });
    });
  });

  describe("sse.error", () => {
    it("sends an error event with code, detail and the failed message after the deltas; the status stays 200", async () => {
      await start();
      fake.script({ deltas: ["par", "tial", "never"], throwAfter: 2 });
      const session = await createSession(app);

      const stream = await streamSend(session.id, "Hi");
      const { frames, error } = await stream.drain();

      expect(stream.status).toBe(200);
      expect(error).toBeUndefined();
      const events = eventsOf(frames);
      const created = events[0]?.data as TurnBody;
      // The fake throws before its third chunk; how much text the snapshot already holds
      // depends on timing, so only the whole is fixed.
      const deltas = events.filter(({ event }) => event === "delta");
      expect(created.assistantMessage.content + deltas.map(({ data }) => text(data)).join("")).toBe(
        "partial",
      );
      const last = events.at(-1);
      expect(events.map(({ event }) => event)).toEqual([
        "message.created",
        ...deltas.map(() => "delta"),
        "error",
      ]);
      expect(last?.data).toEqual({
        code: "llm_upstream_error",
        detail: expect.any(String),
        assistantMessage: expect.objectContaining({
          id: created.assistantMessage.id,
          status: "failed",
          content: "partial",
          errorCode: "llm_upstream_error",
        }),
      });
      const { detail, assistantMessage } = last?.data as {
        detail: string;
        assistantMessage: Message;
      };
      expect(detail).toBe(assistantMessage.errorDetail);
    });

    it("answers a busy session with 409 problem details instead of a stream", async () => {
      await start();
      holdGeneration(["Hel", "lo"]);
      const session = await createSession(app);
      expect(
        (await send(app, session.id, { content: "First" }, { prefer: "respond-async" })).statusCode,
      ).toBe(202);

      const response = await send(
        app,
        session.id,
        { content: "Second" },
        { accept: "text/event-stream" },
      );

      expect(response.statusCode).toBe(409);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.headers.vary).toBe("Accept");
      expect(response.json()).toMatchObject({ status: 409, code: "session_busy" });
    });

    it("answers an invalid body and an unknown session with problem details instead of a stream", async () => {
      await start();
      const session = await createSession(app);

      const invalid = await send(app, session.id, { content: "" }, { accept: "text/event-stream" });
      const unknown = await send(
        app,
        "0190f5a0-0000-7000-8000-00000000dead",
        { content: "Hi" },
        { accept: "text/event-stream" },
      );

      expect(invalid.statusCode).toBe(400);
      expect(invalid.headers.vary).toBe("Accept");
      expect(invalid.json()).toMatchObject({ code: "validation_error" });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.headers["content-type"]).toContain("application/problem+json");
      expect(unknown.headers.vary).toBe("Accept");
      expect(unknown.json()).toMatchObject({ code: "session_not_found" });
    });
  });

  describe("sse.negotiation", () => {
    it.each([
      ["application/json, text/event-stream;q=0.5"],
      ["text/event-stream, */*"],
      ["text/event-stream;q=0"],
      [""],
    ])("answers JSON with Vary: Accept for Accept %j", async (accept) => {
      await start();
      const session = await createSession(app);

      const response = await send(app, session.id, { content: "Hi" }, { accept });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.headers.vary).toBe("Accept");
      expect(response.json()).toMatchObject({
        assistantMessage: { status: "completed", content: "Hello" },
      });
    });

    it("streams when the event stream has a higher q than JSON", async () => {
      await start();
      const session = await createSession(app);

      const stream = await streamSend(session.id, "Hi", {
        accept: "text/event-stream, application/json;q=0.9",
      });

      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(stream.headers.get("vary")).toBe("Accept");
      const { error, frames } = await stream.drain();
      expect(error).toBeUndefined();
      expect(eventsOf(frames).at(-1)?.event).toBe("done");
    });
  });

  describe("sse.disconnect", () => {
    it("keeps generating after the client closes mid-stream and stores the whole answer", async () => {
      await start();
      const release = holdGeneration(["Hel", "lo", " there"], 1);
      const session = await createSession(app);

      const stream = await streamSend(session.id, "Hi");
      const created = await stream.nextEvent();
      const { assistantMessage } = created?.data as TurnBody;
      // The first chunk, live or already in the snapshot; the rest is held.
      if (assistantMessage.content === "") {
        expect((await stream.nextEvent())?.data).toMatchObject({ text: "Hel" });
      }
      stream.close();
      release();

      const stored = await eventually(
        () => getMessage(app, session.id, assistantMessage.id),
        (response) => response.json().status !== "generating",
      );
      expect(stored.json()).toMatchObject({ status: "completed", content: "Hello there" });
    });
  });

  describe("sse.ping", () => {
    it("sends ping comments while the answer is quiet", async () => {
      await start({ SSE_PING_INTERVAL_MS: "100" });
      const release = holdGeneration(["Hel", "lo"]);
      const session = await createSession(app);

      const stream = await streamSend(session.id, "Hi");
      let pings = 0;
      // Bounded by the test timeout, not by a fixed pause.
      while (pings < 3) {
        const frame = await stream.next();
        expect(frame).toBeDefined();
        if (frame?.kind === "comment") {
          expect(frame.raw).toBe(": ping");
          pings += 1;
        }
      }
      release();
      const { frames, error } = await stream.drain();

      expect(error).toBeUndefined();
      expect(eventsOf(frames).at(-1)?.event).toBe("done");
    });
  });

  describe("sse.shutdown", () => {
    it("ends an open stream with error / cancelled when the server shuts down", async () => {
      await start();
      holdGeneration(["Hel", "lo"], 1);
      const session = await createSession(app);
      const stream = await streamSend(session.id, "Hi");
      expect((await stream.nextEvent())?.event).toBe("message.created");

      const closing = app.close();
      const { frames, error } = await stream.drain();
      await closing;

      expect(error).toBeUndefined();
      const last = eventsOf(frames).at(-1);
      expect(last?.event).toBe("error");
      expect(last?.data).toMatchObject({
        code: "cancelled",
        assistantMessage: { status: "failed", errorCode: "cancelled" },
      });
    });
  });

  describe("sse.slow-consumer", () => {
    it("closes a connection that stops reading before its pending bytes pass the limit; the answer still completes", async () => {
      const logs = captureLogs();
      // No flush while the answer grows to 16 MiB: only its final state is written.
      await start({ LOG_LEVEL: "warn", FLUSH_INTERVAL_MS: "60000" }, logs.stream);
      // Far more than the operating system buffers for a client that does not read.
      const piece = "x".repeat(4096);
      const count = 4096;
      fake.script({ deltas: Array.from({ length: count }, () => piece) });
      const session = await createSession(app);

      const stream = await streamSend(session.id, "Hi");
      const created = await stream.nextEvent();
      const { assistantMessage } = created?.data as TurnBody;
      // The client reads nothing more until the answer is stored.
      const stored = await eventually(
        () => getMessage(app, session.id, assistantMessage.id),
        (response) => response.json().status !== "generating",
        30_000,
      );
      const { frames, error } = await stream.drain();

      expect(stored.json().status).toBe("completed");
      expect(stored.json().content).toBe(piece.repeat(count));
      // Destroyed: the chunked body never got its terminating chunk, unlike a stream that ended.
      expect(error).toBeDefined();
      const events = eventsOf(frames);
      expect(events.length).toBeLessThan(count);
      expect(events.map(({ event }) => event)).not.toContain("done");
      const closing = logs
        .entries()
        .filter((entry) => entry.msg === "closing an event stream whose client does not keep up");
      expect(closing).toHaveLength(1);
      const { pendingBytes, frameBytes, limitBytes } = closing[0] as {
        pendingBytes: number;
        frameBytes: number;
        limitBytes: number;
      };
      expect(limitBytes).toBe(262_144);
      // The refused frame found a backlog and would have taken it past the limit.
      expect(pendingBytes).toBeGreaterThan(0);
      expect(pendingBytes + frameBytes).toBeGreaterThan(limitBytes);
    }, 60_000);
  });
});

function text(data: unknown): string {
  return (data as { text: string }).text;
}
