import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { loadCatalog } from "../../src/llm/catalog.js";
import { createAdapters } from "../../src/llm/providers.js";
import { createRegistry } from "../../src/llm/registry.js";
import { TEST_ENV, makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { createSession, send } from "../helpers/messages.js";
import { UPSTREAM_BASE_URL, errorOf, streamOf, useUpstream } from "../helpers/msw-openai.js";

const testDb = useTestDatabase();
const upstream = useUpstream();

// The adapters the server entry builds, with OLLAMA_BASE_URL aimed at the msw upstream: the
// local model is the OpenAI-compatible adapter with another base URL and no key.
describe("ollama provider", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  /** `env` adds settings, such as an operator key (`OLLAMA_API_KEY`). */
  function start(env: Record<string, string> = {}): void {
    const config = loadConfig({
      ...TEST_ENV,
      PROVIDERS_ENABLED: "demo,ollama",
      OLLAMA_BASE_URL: UPSTREAM_BASE_URL,
      ...env,
    });
    const catalog = loadCatalog(config.modelCatalogPath);
    app = makeTestApp({
      db: testDb.db,
      config,
      catalog,
      registry: createRegistry(catalog, config, createAdapters(config)),
      operatorKeys: config.operatorKeys,
    });
  }

  it("is listed as keyless with its catalogued model", async () => {
    start();

    const response = await app.inject({ method: "GET", url: "/providers" });

    expect(response.json().providers).toContainEqual({
      id: "ollama",
      requiresKey: false,
      defaultModel: "qwen2.5:0.5b",
      models: [{ id: "qwen2.5:0.5b", contextWindow: 4096, maxOutputTokens: 512 }],
    });
  });

  it("answers without any key through the configured base URL, sending the placeholder no-key and the catalog's output limit", async () => {
    start();
    upstream.reply(
      streamOf([
        { content: "4" },
        { finishReason: "stop" },
        { noChoices: true, usage: { prompt_tokens: 30, completion_tokens: 1 } },
      ]),
    );
    const session = await createSession(app, { provider: "ollama" });

    const response = await send(app, session.id, { content: "What is 2+2?" });

    expect(response.statusCode).toBe(200);
    expect(response.json().assistantMessage).toMatchObject({
      status: "completed",
      content: "4",
      provider: "ollama",
      model: "qwen2.5:0.5b",
      usage: { promptTokens: 30, completionTokens: 1 },
      finishReason: "stop",
    });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.authorization).toBe("Bearer no-key");
    expect(upstream.requests[0]?.body).toMatchObject({
      model: "qwen2.5:0.5b",
      max_tokens: 512,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "What is 2+2?" }],
    });
  });

  // #33: a keyless provider never receives a credential, whatever the request or the server has.
  describe("never receives a key (#33)", () => {
    const CALLER_KEY = "caller-key-not-real-33";
    const OPERATOR_KEY = "operator-key-not-real-33";
    const answer = streamOf([{ content: "4", finishReason: "stop" }]);

    function expectOnlyThePlaceholder(key: string): void {
      expect(upstream.requests).toHaveLength(1);
      expect(upstream.requests[0]?.authorization).toBe("Bearer no-key");
      expect(JSON.stringify(upstream.requests[0])).not.toContain(key);
    }

    it("sends the placeholder, never the caller's X-LLM-Api-Key", async () => {
      start();
      upstream.reply(answer);
      const session = await createSession(app, { provider: "ollama" });

      const response = await send(
        app,
        session.id,
        { content: "What is 2+2?" },
        { "x-llm-api-key": CALLER_KEY },
      );

      expect(response.statusCode).toBe(200);
      expect(response.json().assistantMessage).toMatchObject({ status: "completed", content: "4" });
      expectOnlyThePlaceholder(CALLER_KEY);
    });

    it("sends the placeholder, never an operator key configured for it", async () => {
      start({ OLLAMA_API_KEY: OPERATOR_KEY });
      upstream.reply(answer);
      const session = await createSession(app, { provider: "ollama" });

      const response = await send(app, session.id, { content: "What is 2+2?" });

      expect(response.statusCode).toBe(200);
      expectOnlyThePlaceholder(OPERATOR_KEY);
    });

    it("still rejects a malformed X-LLM-Api-Key with 400, never echoing it", async () => {
      start();
      const session = await createSession(app, { provider: "ollama" });
      const malformed = "bad key-value-33";

      const response = await send(
        app,
        session.id,
        { content: "What is 2+2?" },
        { "x-llm-api-key": malformed },
      );

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "validation_error" });
      expect(response.body).not.toContain(malformed);
      expect(response.body).toContain("x-llm-api-key");
      expect(upstream.requests).toHaveLength(0);
    });
  });

  it("does not retry a failed request: a CPU model would redo the whole prompt", async () => {
    start();
    upstream.reply(
      errorOf(500, { error: { message: "model runner crashed" } }),
      streamOf([{ content: "4", finishReason: "stop" }]),
    );
    const session = await createSession(app, { provider: "ollama" });

    const response = await send(app, session.id, { content: "What is 2+2?" });

    expect(response.statusCode).toBe(502);
    expect(response.json().assistantMessage).toMatchObject({
      status: "failed",
      errorCode: "llm_upstream_error",
    });
    expect(upstream.requests).toHaveLength(1);
  });
});
