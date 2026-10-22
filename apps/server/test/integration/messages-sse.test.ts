import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { TEST_ENV, makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider, createGate } from "../helpers/fake-llm.js";
import { type LogCapture, captureLogs } from "../helpers/log-capture.js";
import { type Message, createSession } from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";
import { type SseConnection, eventsOf, listen, openSse } from "../helpers/sse-client.js";

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
    await app.close();
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
});
