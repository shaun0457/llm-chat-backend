import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { runSmoke } from "../../scripts/smoke-local-llm.js";
import { loadConfig } from "../../src/config.js";
import { loadCatalog } from "../../src/llm/catalog.js";
import { createRegistry } from "../../src/llm/registry.js";
import { TEST_ENV, makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider, createGate } from "../helpers/fake-llm.js";
import { closeListeningApp, listen } from "../helpers/sse-client.js";

const testDb = useTestDatabase();

// The CI smoke script against a real listening app: the shipped catalog (ollama: limit 2, 512
// output tokens) with a fake standing in for the local model.
describe("smoke-local-llm script", () => {
  let app: FastifyInstance;
  let ollama: FakeLlmProvider;
  let baseUrl: string;
  const quiet = (): void => {};

  /** `beforeListen` runs once the app is built, e.g. to add a hook. */
  async function start(beforeListen: () => void = () => {}): Promise<void> {
    const config = loadConfig({ ...TEST_ENV, PROVIDERS_ENABLED: "demo,ollama" });
    const catalog = loadCatalog(config.modelCatalogPath);
    ollama = new FakeLlmProvider("ollama");
    app = makeTestApp({
      db: testDb.db,
      config,
      catalog,
      registry: createRegistry(catalog, config, { demo: new FakeLlmProvider("demo"), ollama }),
    });
    beforeListen();
    baseUrl = await listen(app);
  }

  afterEach(async () => {
    await closeListeningApp(app);
  });

  it("passes with a completed answer over SSE and as JSON, reporting timings and usage", async () => {
    await start();
    ollama.script({ deltas: ["Fo", "ur"] }, { deltas: ["4"] });

    const result = await runSmoke({ baseUrl, provider: "ollama", log: quiet });

    expect(result.model).toBe("qwen2.5:0.5b");
    expect(result.sse).toMatchObject({
      content: "Four",
      finishReason: "stop",
      usage: { promptTokens: 7, completionTokens: 2 },
      deltas: 2,
    });
    expect(result.sse.firstDeltaMs).toBeGreaterThanOrEqual(0);
    expect(result.sse.totalMs).toBeGreaterThanOrEqual(result.sse.firstDeltaMs ?? 0);
    expect(result.json).toMatchObject({ httpStatus: 200, content: "4", finishReason: "stop" });
    expect(ollama.requests.map((request) => request.messages.at(-1)?.content)).toEqual([
      "What is 2+2? Answer with one number.",
      "What is 2+2? Answer with one number.",
    ]);
  });

  it("polls a 202 JSON answer until it completed", async () => {
    await start();
    ollama.script({}, { deltas: ["Fo", "ur"], delayMs: 500 });

    const result = await runSmoke({ baseUrl, provider: "ollama", jsonWaitSeconds: 0, log: quiet });

    expect(result.json).toMatchObject({ httpStatus: 202, content: "Four", status: "completed" });
    expect(result.json.polls).toBeGreaterThanOrEqual(1);
  });

  it("fails naming the provider when it is not enabled", async () => {
    await start();

    await expect(runSmoke({ baseUrl, provider: "nvidia", log: quiet })).rejects.toThrow(
      /provider "nvidia" is not enabled/,
    );
  });

  it("fails with the error code when the streamed answer fails", async () => {
    await start();
    ollama.script({ throwAfter: 0 });

    await expect(runSmoke({ baseUrl, provider: "ollama", log: quiet })).rejects.toThrow(
      /SSE answer.*llm_upstream_error/,
    );
  });

  it("fails when the answer inlines reasoning", async () => {
    await start();
    ollama.script({ deltas: ["<think>Two and two.</think>", "4"] });

    await expect(runSmoke({ baseUrl, provider: "ollama", log: quiet })).rejects.toThrow(
      /reasoning/,
    );
  });

  describe("with the limit check", () => {
    type Finish = { reason: "stop" | "length"; tokens: number };

    /** Two long answers that stay generating until the third send was answered 503. */
    function holdUntilRejected(first: Finish, second: Finish = first): void {
      const gate = createGate();
      app.addHook("onResponse", async (_request, reply) => {
        if (reply.statusCode === 503) {
          gate.release();
        }
      });
      const long = (finish: Finish) => ({
        deltas: ["1 2 3", " 4 5 6"],
        finishGate: gate.promise,
        finishReason: finish.reason,
        usage: { promptTokens: 20, completionTokens: finish.tokens },
      });
      ollama.script({}, {}, long(first), long(second));
    }

    it("proves the limit and the output cap: a third concurrent send gets 503, both answers end at length", async () => {
      await start(() => holdUntilRejected({ reason: "length", tokens: 512 }));

      const result = await runSmoke({ baseUrl, provider: "ollama", limitCheck: true, log: quiet });

      expect(result.limit).toMatchObject({
        concurrency: 2,
        rejected: { httpStatus: 503, code: "provider_busy", retryAfter: "10" },
        answers: [
          { finishReason: "length", usage: { completionTokens: 512 } },
          { finishReason: "length", usage: { completionTokens: 512 } },
        ],
        overlapped: true,
      });
    });

    it("fails at once with the real cause when a long answer fails while the other still runs", async () => {
      await start(() => {
        ollama.script(
          {},
          {},
          { deltas: ["1 2 3"], hang: true },
          { deltas: ["1 2"], throwAfter: 1 },
        );
      });

      // The other answer never ends on its own: only stopping it lets the script return.
      await expect(
        runSmoke({ baseUrl, provider: "ollama", limitCheck: true, log: quiet }),
      ).rejects.toThrow(/long answer 2 failed: llm_upstream_error/);
    });

    it("accepts one long answer that stops early when the other ends at the output limit", async () => {
      await start(() =>
        holdUntilRejected({ reason: "stop", tokens: 300 }, { reason: "length", tokens: 512 }),
      );

      const result = await runSmoke({ baseUrl, provider: "ollama", limitCheck: true, log: quiet });

      expect(result.limit?.answers.map((answer) => answer.finishReason)).toEqual([
        "stop",
        "length",
      ]);
    });

    it("fails when no long answer ends at the output limit", async () => {
      await start(() => holdUntilRejected({ reason: "stop", tokens: 300 }));

      await expect(
        runSmoke({ baseUrl, provider: "ollama", limitCheck: true, log: quiet }),
      ).rejects.toThrow(/no long answer ended at the output limit/);
    });

    it("fails when an answer goes past the catalog's output limit", async () => {
      await start(() => holdUntilRejected({ reason: "stop", tokens: 600 }));

      await expect(
        runSmoke({ baseUrl, provider: "ollama", limitCheck: true, log: quiet }),
      ).rejects.toThrow(/output limit/);
    });
  });
});
