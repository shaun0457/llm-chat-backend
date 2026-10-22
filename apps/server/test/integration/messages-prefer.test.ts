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
/**
 * Any wait (default or requested, up to 60 s) outlasts the 5 s test timeout, so a test that
 * gets its response at all shows that the server did not wait, without a wall-clock bound.
 */
const LONG_WAIT_ENV = { ...TEST_ENV, JSON_DEFAULT_WAIT_MS: "60000", JSON_MAX_WAIT_MS: "60000" };

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

  describe("prefer.wait", () => {
    it("waits longer than the default when asked and answers 200 with Preference-Applied", async () => {
      // Default 200 ms; the answer takes about 300 ms.
      start();
      fake.script({ deltas: ["Hel", "lo"], delayMs: 300 });
      const session = await createSession(app);

      const response = await send(app, session.id, { content: "Hi" }, { prefer: "wait=2" });

      expect(response.statusCode).toBe(200);
      expect(response.headers["preference-applied"]).toBe("wait=2");
      expect(response.json().assistantMessage).toMatchObject({
        status: "completed",
        content: "Hello",
      });
    });

    it("waits less than the default when asked", async () => {
      start(LONG_WAIT_ENV);
      holdGeneration();
      const session = await createSession(app);

      const response = await send(app, session.id, { content: "Hi" }, { prefer: "wait=0" });

      expect(response.statusCode).toBe(202);
      expect(response.headers["preference-applied"]).toBe("wait=0");
    });
  });

  describe("prefer.cap", () => {
    it("waits at most the maximum and reports the cap in Preference-Applied", async () => {
      start({ ...WAIT_ENV, JSON_MAX_WAIT_MS: "1000" });
      holdGeneration();
      const session = await createSession(app);

      const { value: response, elapsedMs } = await timed(() =>
        send(app, session.id, { content: "Hi" }, { prefer: "wait=60" }),
      );

      expect(response.statusCode).toBe(202);
      expect(response.headers["preference-applied"]).toBe("wait=1");
      // Uncapped, wait=60 would outlast the test timeout.
      expect(elapsedMs).toBeGreaterThanOrEqual(990);
    });
  });

  describe("prefer.async", () => {
    it.each(["respond-async", "respond-async, wait=5", "wait=5, Respond-Async"])(
      "answers 202 without waiting for %s and applies only respond-async",
      async (prefer) => {
        start(LONG_WAIT_ENV);
        holdGeneration();
        const session = await createSession(app);

        const response = await send(app, session.id, { content: "Hi" }, { prefer });

        expect(response.statusCode).toBe(202);
        expect(response.headers["preference-applied"]).toBe("respond-async");
        expect(response.headers["cache-control"]).toBe("no-store");
        const { assistantMessage }: TurnBody = response.json();
        expect(response.headers.location).toBe(
          `/sessions/${session.id}/messages/${assistantMessage.id}`,
        );
      },
    );
  });

  describe("prefer.malformed", () => {
    it.each([
      "wait=abc",
      "wait=-1, foo",
      "wait=1.5; x=y",
      'handling=lenient, "wait"=3',
      ",,;",
      "respond-async=",
      'respond-async="unterminated',
    ])(
      "ignores %j: the default wait applies, no 400, nothing applied",
      async (prefer) => {
        start();
        holdGeneration();
        const session = await createSession(app);

        const { value: response, elapsedMs } = await timed(() =>
          send(app, session.id, { content: "Hi" }, { prefer }),
        );

        expect(response.statusCode).toBe(202);
        expect(elapsedMs).toBeGreaterThanOrEqual(190);
        expect(response.headers["preference-applied"]).toBeUndefined();
      },
    );
  });

  describe("prefer.failure", () => {
    it("answers 502 with both messages when the answer fails within the wait", async () => {
      start();
      fake.script({ deltas: ["Hel", "lo"], throwAfter: 1 });
      const session = await createSession(app);

      const response = await send(app, session.id, { content: "Hi" }, { prefer: "wait=2" });

      expect(response.statusCode).toBe(502);
      expect(response.headers["content-type"]).toMatch(/^application\/problem\+json/);
      expect(response.headers["preference-applied"]).toBe("wait=2");
      expect(response.headers.location).toBeUndefined();
      const body = response.json();
      expect(body).toMatchObject({
        status: 502,
        code: "llm_upstream_error",
        userMessage: { role: "user", content: "Hi" },
        assistantMessage: { status: "failed", content: "Hel", errorCode: "llm_upstream_error" },
      });
    });
  });

  describe("prefer.disconnect", () => {
    it("lets the answer finish and be stored when the client leaves during the wait", async () => {
      start(LONG_WAIT_ENV);
      const release = holdGeneration(["Hel", "lo"]);
      const session = await createSession(app);
      await app.listen({ port: 0, host: "127.0.0.1" });
      const { port } = app.server.address() as AddressInfo;
      const leaving = new AbortController();

      const sent = fetch(`http://127.0.0.1:${port}/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Hi" }),
        signal: leaving.signal,
      });
      const generating = await eventually(
        () => app.inject({ method: "GET", url: `/sessions/${session.id}/messages?limit=2` }),
        (page) => page.json().items.length === 2,
      );
      leaving.abort();
      await expect(sent).rejects.toThrow();
      release();

      const assistant = (generating.json().items as Message[])[1];
      const stored = await eventually(
        () =>
          app.inject({ method: "GET", url: `/sessions/${session.id}/messages/${assistant?.id}` }),
        (poll) => poll.json().status !== "generating",
      );
      expect(stored.json()).toMatchObject({ status: "completed", content: "Hello" });
    });
  });

  describe("poll", () => {
    it("shows the current state on every poll, never cached, until the answer completes", async () => {
      start();
      // Holds after its first chunk, and again before finishing, until each gate is released.
      const second = createGate();
      const finish = createGate();
      gates.push(second.release, finish.release);
      fake.script({
        deltas: ["one ", "two "],
        gate: second.promise,
        gateAfter: 1,
        finishGate: finish.promise,
      });
      const session = await createSession(app);
      const sent = await send(app, session.id, { content: "Hi" }, { prefer: "respond-async" });
      expect(sent.statusCode).toBe(202);
      const poll = () => app.inject({ method: "GET", url: String(sent.headers.location) });

      const afterOne = await eventually(poll, (response) => response.json().content.length > 0);
      second.release();
      const afterTwo = await eventually(poll, (response) => response.json().content === "one two ");
      finish.release();
      const last = await eventually(poll, (response) => response.json().status !== "generating");

      expect(afterOne.json()).toMatchObject({ status: "generating", content: "one " });
      expect(afterTwo.json()).toMatchObject({ status: "generating", content: "one two " });
      expect(last.json()).toMatchObject({ status: "completed", content: "one two " });
      for (const response of [afterOne, afterTwo, last]) {
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
    });

    it("does not let a 404 be cached either", async () => {
      start();
      const session = await createSession(app);

      const response = await app.inject({
        method: "GET",
        url: `/sessions/${session.id}/messages/0190f5a0-0000-7000-8000-000000000000`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe("message_not_found");
      expect(response.headers["cache-control"]).toBe("no-store");
    });

    it("ends in failed when the answer fails after the 202", async () => {
      start();
      const gate = createGate();
      gates.push(gate.release);
      fake.script({ deltas: ["Hel", "lo"], gate: gate.promise, gateAfter: 1, throwAfter: 1 });
      const session = await createSession(app);
      const sent = await send(app, session.id, { content: "Hi" }, { prefer: "respond-async" });
      expect(sent.statusCode).toBe(202);

      gate.release();
      const last = await eventually(
        () => app.inject({ method: "GET", url: String(sent.headers.location) }),
        (response) => response.json().status !== "generating",
      );

      expect(last.statusCode).toBe(200);
      expect(last.headers["cache-control"]).toBe("no-store");
      expect(last.json()).toMatchObject({ status: "failed", errorCode: "llm_upstream_error" });
    });
  });
});
