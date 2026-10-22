import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import type { LlmProvider } from "../../src/llm/port.js";
import { TEST_ENV, makeTestApp } from "../helpers/app.js";
import { clockJumpingAfterFirstReading } from "../helpers/clock.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider } from "../helpers/fake-llm.js";
import { createSession, getMessage, send } from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";

const testDb = useTestDatabase();

describe("deadline", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe("fractional remaining time", () => {
    const DEADLINE_MS = 10_000;
    /** As if admission took all but 250.75 ms of the deadline. */
    const clock = () => clockJumpingAfterFirstReading(DEADLINE_MS - 250.75);
    const config = loadConfig({ ...TEST_ENV, GENERATION_DEADLINE_MS: String(DEADLINE_MS) });

    it("generates normally within what is left; no RangeError escapes worker startup", async () => {
      const fake = new FakeLlmProvider().script({ deltas: ["Quick"] });
      app = makeTestApp({ db: testDb.db, config, clock: clock(), ...testProviders({ llm: fake }) });
      const session = await createSession(app);

      const response = await send(app, session.id, { content: "Hi" });

      expect(response.statusCode).toBe(200);
      expect(response.json().assistantMessage).toMatchObject({
        status: "completed",
        content: "Quick",
      });
    });

    it("stops the generation when what was left runs out, not the whole deadline later", async () => {
      const fake = new FakeLlmProvider().script({ deltas: ["Slow"], hang: true });
      app = makeTestApp({ db: testDb.db, config, clock: clock(), ...testProviders({ llm: fake }) });
      const session = await createSession(app);

      // The whole deadline (10 s) would exceed the test's own 5 s timeout.
      const response = await send(app, session.id, { content: "Hi" });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({
        code: "llm_timeout",
        assistantMessage: { status: "failed", errorCode: "llm_timeout", content: "Slow" },
      });
    });
  });

  it("deadline.expiry: a provider that never finishes fails as llm_timeout with its partial text", async () => {
    const config = loadConfig({ ...TEST_ENV, GENERATION_DEADLINE_MS: "300" });
    const fake = new FakeLlmProvider().script({ deltas: ["Par", "tial"], hang: true });
    app = makeTestApp({ db: testDb.db, config, ...testProviders({ llm: fake }) });
    const session = await createSession(app);

    const response = await send(app, session.id, { content: "Hi" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      code: "llm_timeout",
      assistantMessage: { status: "failed", errorCode: "llm_timeout", content: "Partial" },
    });
    expect(fake.signals[0]?.aborted).toBe(true);
    const stored = await getMessage(app, session.id, response.json().assistantMessage.id);
    expect(stored.json()).toMatchObject({ status: "failed", errorCode: "llm_timeout" });
    // The session is free again.
    const next = await send(app, session.id, { content: "Again" });
    expect(next.statusCode).toBe(200);
  });

  it("deadline.no-time-left: admission that outlasted the deadline fails without calling the provider", async () => {
    const DEADLINE_MS = 1_000;
    const config = loadConfig({ ...TEST_ENV, GENERATION_DEADLINE_MS: String(DEADLINE_MS) });
    const fake = new FakeLlmProvider();
    app = makeTestApp({
      db: testDb.db,
      config,
      // As if the admitting transaction took longer than the whole deadline to commit.
      clock: clockJumpingAfterFirstReading(DEADLINE_MS + 1),
      ...testProviders({ llm: fake }),
    });
    const session = await createSession(app);

    const response = await send(app, session.id, { content: "Hi" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      code: "llm_timeout",
      assistantMessage: { status: "failed", errorCode: "llm_timeout", content: "" },
    });
    expect(fake.requests).toHaveLength(0);
    expect((await send(app, session.id, { content: "Again" })).statusCode).toBe(200);
  });

  it("deadline.expiry also ends a generation whose provider ignores the abort signal", async () => {
    const config = loadConfig({ ...TEST_ENV, GENERATION_DEADLINE_MS: "300" });
    const deaf: LlmProvider = {
      id: "deaf",
      async *stream() {
        yield { type: "delta", text: "Deaf" };
        // Never continues and never looks at its signal.
        await new Promise(() => {});
      },
    };
    app = makeTestApp({ db: testDb.db, config, ...testProviders({ llm: deaf }) });
    const session = await createSession(app);

    const response = await send(app, session.id, { content: "Hi" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      code: "llm_timeout",
      assistantMessage: { status: "failed", errorCode: "llm_timeout", content: "Deaf" },
    });
  });

  it("stores an answer as soon as its finish event arrives, even if the stream stays open", async () => {
    const config = loadConfig({ ...TEST_ENV, GENERATION_DEADLINE_MS: "300" });
    const lingering: LlmProvider = {
      id: "lingering",
      async *stream() {
        yield { type: "delta", text: "Complete" };
        yield { type: "finish", reason: "stop", usage: null };
        // The upstream connection is not closed yet (and the signal is ignored).
        await new Promise(() => {});
      },
    };
    app = makeTestApp({ db: testDb.db, config, ...testProviders({ llm: lingering }) });
    const session = await createSession(app);

    const response = await send(app, session.id, { content: "Hi" });

    expect(response.statusCode).toBe(200);
    expect(response.json().assistantMessage).toMatchObject({
      status: "completed",
      content: "Complete",
      finishReason: "stop",
    });
  });
});
