import { sql } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { TEST_ENV, makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider, createGate } from "../helpers/fake-llm.js";
import {
  type Session,
  allMessages,
  createSession,
  eventually,
  getSession,
  send,
} from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";

const testDb = useTestDatabase();

// Providers: demo (keyless, no maxConcurrency: MAX_ACTIVE_PER_PROVIDER applies), other (needs a
// key, which the test app has unless `operatorKeys` says otherwise; maxConcurrency 2; o-small
// has a 4,096-token window), off (not enabled). The fake serves both enabled providers.
describe("admission limits", () => {
  let app: FastifyInstance;
  let fake: FakeLlmProvider;
  /** Gates still closed at the end of a test; opened so that closing the app is quick. */
  let gates: Array<() => void>;
  let pending: Array<Promise<LightMyRequestResponse>>;

  function start(
    env: Record<string, string>,
    options: { operatorKeys?: Readonly<Record<string, string>> } = {},
  ): void {
    fake = new FakeLlmProvider();
    gates = [];
    pending = [];
    app = makeTestApp({
      db: testDb.db,
      config: loadConfig({ ...TEST_ENV, ...env }),
      ...options,
      ...testProviders({ llm: fake }),
    });
  }

  afterEach(async () => {
    for (const release of gates) {
      release();
    }
    await Promise.all(pending);
    await app.close();
  });

  /**
   * Sends a turn whose generation waits at a gate, and returns once the provider was called.
   * `open()` lets it finish; the response then settles after its reservation was released.
   */
  async function holdOpen(
    session: Session,
    payload: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<{ open: () => Promise<LightMyRequestResponse> }> {
    const gate = createGate();
    gates.push(gate.release);
    fake.script({ deltas: ["Held"], gate: gate.promise });
    const calls = fake.requests.length;
    const response = send(app, session.id, { content: "Hold", ...payload }, headers);
    pending.push(response);
    await eventually(
      async () => fake.requests.length,
      (length) => length > calls,
    );
    return {
      open: async () => {
        gate.release();
        return response;
      },
    };
  }

  /** The rejection left no rows and no other trace on the session. */
  async function expectUntouched(session: Session): Promise<void> {
    expect(await allMessages(app, session.id)).toEqual([]);
    expect(await getSession(app, session.id)).toEqual(session);
  }

  describe("capacity", () => {
    it("answers 503 server_busy with Retry-After: 10 at the process limit, and admits again once a slot frees", async () => {
      start({ MAX_ACTIVE_GENERATIONS: "2", MAX_ACTIVE_PER_PROVIDER: "4" });
      const first = await holdOpen(await createSession(app));
      await holdOpen(await createSession(app));
      const third = await createSession(app);

      const rejected = await send(app, third.id, { content: "Hi" });

      expect(rejected.statusCode).toBe(503);
      expect(rejected.headers["content-type"]).toContain("application/problem+json");
      expect(rejected.headers["retry-after"]).toBe("10");
      expect(rejected.json()).toMatchObject({ status: 503, code: "server_busy" });
      await expectUntouched(third);
      expect((await first.open()).statusCode).toBe(200);
      const admitted = await send(app, third.id, { content: "Hi" });
      expect(admitted.statusCode).toBe(200);
    });

    it("answers 503 provider_busy naming the provider and its limit, while another provider is free", async () => {
      start({ MAX_ACTIVE_GENERATIONS: "8", MAX_ACTIVE_PER_PROVIDER: "1" });
      await holdOpen(await createSession(app));
      const second = await createSession(app);

      const rejected = await send(app, second.id, { content: "Hi" });

      expect(rejected.statusCode).toBe(503);
      expect(rejected.headers["retry-after"]).toBe("10");
      expect(rejected.json()).toMatchObject({ status: 503, code: "provider_busy" });
      expect(rejected.json().detail).toContain('"demo"');
      expect(rejected.json().detail).toContain("1 active");
      await expectUntouched(second);
      const elsewhere = await send(app, second.id, { content: "Hi", provider: "other" });
      expect(elsewhere.statusCode).toBe(200);
    });

    it("takes a provider's limit from its catalog maxConcurrency before MAX_ACTIVE_PER_PROVIDER", async () => {
      start({ MAX_ACTIVE_GENERATIONS: "8", MAX_ACTIVE_PER_PROVIDER: "1" });
      await holdOpen(await createSession(app, { provider: "other" }));
      await holdOpen(await createSession(app, { provider: "other" }));
      const third = await createSession(app, { provider: "other" });

      const rejected = await send(app, third.id, { content: "Hi" });

      expect(rejected.json()).toMatchObject({ code: "provider_busy" });
      expect(rejected.json().detail).toContain('"other"');
      expect(rejected.json().detail).toContain("2 active");
    });
  });

  describe("capacity.release", () => {
    it("gives the slot back when the admission fails after reserving it", async () => {
      start({ MAX_ACTIVE_GENERATIONS: "1" });
      const session = await createSession(app);
      // A test-only constraint makes the turn's insert fail after capacity was reserved.
      await testDb.db.drizzle.execute(
        sql`ALTER TABLE messages ADD CONSTRAINT test_reject_boom CHECK (content <> 'boom')`,
      );
      try {
        const failed = await send(app, session.id, { content: "boom" });

        expect(failed.statusCode).toBe(500);
        await expectUntouched(session);
      } finally {
        await testDb.db.drizzle.execute(sql`ALTER TABLE messages DROP CONSTRAINT test_reject_boom`);
      }
      const admitted = await send(app, session.id, { content: "fine" });
      expect(admitted.statusCode).toBe(200);
    });

    it("returns every slot after 50 completed turns: the full limit is admitted again", async () => {
      start({ MAX_ACTIVE_GENERATIONS: "2", MAX_ACTIVE_PER_PROVIDER: "2" });
      const busy = await createSession(app);
      for (let turn = 1; turn <= 50; turn += 1) {
        const response = await send(app, busy.id, { content: `Turn ${turn}` });
        expect(response.statusCode).toBe(200);
      }

      await holdOpen(await createSession(app));
      await holdOpen(await createSession(app));
      const rejected = await send(app, (await createSession(app)).id, { content: "Hi" });

      expect(rejected.json()).toMatchObject({ code: "server_busy" });
    });
  });

  describe("admission.order", () => {
    it("answers session_busy, not server_busy, for a busy session when capacity is full too", async () => {
      start({ MAX_ACTIVE_GENERATIONS: "1" });
      const session = await createSession(app);
      await holdOpen(session);

      const response = await send(app, session.id, { content: "Again" });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "session_busy" });
    });

    it.each([
      ["input_too_long", { content: "x".repeat(16_000) }],
      ["model_not_supported", { content: "Hi", model: "nope" }],
      ["provider_unavailable", { content: "Hi", provider: "off" }],
    ])("answers 422 %s, not session_busy, for a busy session", async (code, payload) => {
      start({ MAX_ACTIVE_GENERATIONS: "1" });
      // o-small: 4,096 − 512 − 410 leaves room for about 9,500 ASCII characters.
      const session = await createSession(app, { provider: "other", model: "o-small" });
      await holdOpen(session);

      const response = await send(app, session.id, payload);

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code });
    });

    it("answers 422 llm_credential_missing, not session_busy, for a busy session", async () => {
      start({ MAX_ACTIVE_GENERATIONS: "1" }, { operatorKeys: {} });
      const session = await createSession(app, { provider: "other" });
      await holdOpen(session, {}, { "x-llm-api-key": "sk-test-only" });

      const response = await send(app, session.id, { content: "Again" });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "llm_credential_missing" });
    });
  });
});
