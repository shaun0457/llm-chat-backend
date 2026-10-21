import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { TEST_ENV, makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider, createGate } from "../helpers/fake-llm.js";
import { type Message, createSession, eventually, send } from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";

const testDb = useTestDatabase();

/** Short waits keep these tests fast; each test states the values it relies on. */
const WAIT_ENV = { ...TEST_ENV, JSON_DEFAULT_WAIT_MS: "200", JSON_MAX_WAIT_MS: "5000" };

type TurnBody = { userMessage: Message; assistantMessage: Message };

describe("JSON sends: Prefer, 202 and polling", () => {
  let app: FastifyInstance;
  let fake: FakeLlmProvider;
  const gates: Array<() => void> = [];

  function start(env: Record<string, string> = WAIT_ENV): FastifyInstance {
    fake = new FakeLlmProvider();
    app = makeTestApp({ db: testDb.db, config: loadConfig(env), ...testProviders({ llm: fake }) });
    return app;
  }

  /** A generation that holds after its chunks until the test (or afterEach) releases it. */
  function holdGeneration(deltas: readonly string[] = ["Hel", "lo"]): () => void {
    const gate = createGate();
    gates.push(gate.release);
    fake.script({ deltas, gate: gate.promise });
    return gate.release;
  }

  async function timed<T>(action: () => Promise<T>): Promise<{ value: T; elapsedMs: number }> {
    const started = performance.now();
    const value = await action();
    return { value, elapsedMs: performance.now() - started };
  }

  afterEach(async () => {
    for (const release of gates.splice(0)) {
      release();
    }
    await app.close();
  });

  describe("prefer.default", () => {
    it("answers 202 after the default wait with both messages, Location, Retry-After and no-store; the answer still completes", async () => {
      start();
      const release = holdGeneration();
      const session = await createSession(app);

      const { value: response, elapsedMs } = await timed(() =>
        send(app, session.id, { content: "Hi" }),
      );

      expect(response.statusCode).toBe(202);
      expect(elapsedMs).toBeGreaterThanOrEqual(190);
      const { userMessage, assistantMessage }: TurnBody = response.json();
      expect(userMessage).toMatchObject({ role: "user", content: "Hi", status: "completed" });
      expect(assistantMessage).toMatchObject({
        role: "assistant",
        status: "generating",
        replyToId: userMessage.id,
        attempt: 1,
      });
      expect(response.headers.location).toBe(
        `/sessions/${session.id}/messages/${assistantMessage.id}`,
      );
      expect(response.headers["retry-after"]).toBe("2");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["preference-applied"]).toBeUndefined();

      release();
      const polled = await eventually(
        () => app.inject({ method: "GET", url: String(response.headers.location) }),
        (poll) => poll.json().status !== "generating",
      );
      expect(polled.statusCode).toBe(200);
      expect(polled.json()).toMatchObject({
        id: assistantMessage.id,
        status: "completed",
        content: "Hello",
      });
    });

    it("keeps Location as the relative message path over a real socket (V1)", async () => {
      start();
      holdGeneration();
      const session = await createSession(app);
      await app.listen({ port: 0, host: "127.0.0.1" });
      const { port } = app.server.address() as AddressInfo;

      const response = await fetch(`http://127.0.0.1:${port}/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Hi" }),
      });

      expect(response.status).toBe(202);
      const { assistantMessage }: TurnBody = await response.json();
      expect(response.headers.get("location")).toBe(
        `/sessions/${session.id}/messages/${assistantMessage.id}`,
      );
      expect(response.headers.get("retry-after")).toBe("2");
    });
  });
});
