import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { loadCatalog } from "../../src/llm/catalog.js";
import { createRegistry } from "../../src/llm/registry.js";
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

const testDb = useTestDatabase();

// The shipped catalog with a fake standing in for the local model: the limit under test is the
// catalog's maxConcurrency for "ollama", not MAX_ACTIVE_PER_PROVIDER (left at its default, 4).
describe("ollama.limit", () => {
  let app: FastifyInstance;
  let ollama: FakeLlmProvider;
  let gates: Array<() => void>;
  let pending: Array<Promise<LightMyRequestResponse>>;

  beforeEach(() => {
    const config = loadConfig({ ...TEST_ENV, PROVIDERS_ENABLED: "demo,ollama" });
    const catalog = loadCatalog(config.modelCatalogPath);
    ollama = new FakeLlmProvider("ollama");
    gates = [];
    pending = [];
    app = makeTestApp({
      db: testDb.db,
      config,
      catalog,
      registry: createRegistry(catalog, config, {
        demo: new FakeLlmProvider("demo"),
        ollama,
      }),
    });
  });

  afterEach(async () => {
    for (const release of gates) {
      release();
    }
    await Promise.all(pending);
    await app.close();
  });

  /** Sends a turn whose ollama generation waits at a gate; returns once ollama was called. */
  async function holdOpen(
    session: Session,
  ): Promise<{ open: () => Promise<LightMyRequestResponse> }> {
    const gate = createGate();
    gates.push(gate.release);
    ollama.script({ deltas: ["Held"], gate: gate.promise });
    const calls = ollama.requests.length;
    const response = send(app, session.id, { content: "Hold" });
    pending.push(response);
    await eventually(
      async () => ollama.requests.length,
      (length) => length > calls,
    );
    return {
      open: async () => {
        gate.release();
        return response;
      },
    };
  }

  it("answers a third concurrent ollama send 503 provider_busy with no rows, leaves demo free, and admits again after a completion", async () => {
    const first = await holdOpen(await createSession(app, { provider: "ollama" }));
    await holdOpen(await createSession(app, { provider: "ollama" }));
    const third = await createSession(app, { provider: "ollama" });

    const rejected = await send(app, third.id, { content: "Hi" });

    expect(rejected.statusCode).toBe(503);
    expect(rejected.headers["content-type"]).toContain("application/problem+json");
    expect(rejected.headers["retry-after"]).toBe("10");
    expect(rejected.json()).toMatchObject({ status: 503, code: "provider_busy" });
    expect(rejected.json().detail).toContain('"ollama"');
    expect(rejected.json().detail).toContain("2 active");
    expect(await allMessages(app, third.id)).toEqual([]);
    expect(await getSession(app, third.id)).toEqual(third);

    const demo = await send(app, (await createSession(app)).id, { content: "Hi" });
    expect(demo.statusCode).toBe(200);
    expect(demo.json()).toMatchObject({ assistantMessage: { provider: "demo" } });

    expect((await first.open()).statusCode).toBe(200);
    const admitted = await send(app, third.id, { content: "Hi" });
    expect(admitted.statusCode).toBe(200);
    expect(admitted.json()).toMatchObject({
      assistantMessage: { provider: "ollama", status: "completed" },
    });
  });
});
