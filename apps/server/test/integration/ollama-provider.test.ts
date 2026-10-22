import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { loadCatalog } from "../../src/llm/catalog.js";
import { createAdapters } from "../../src/llm/providers.js";
import { createRegistry } from "../../src/llm/registry.js";
import { TEST_ENV, makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { createSession, send } from "../helpers/messages.js";
import { UPSTREAM_BASE_URL, streamOf, useUpstream } from "../helpers/msw-openai.js";

const testDb = useTestDatabase();
const upstream = useUpstream();

// The adapters the server entry builds, with OLLAMA_BASE_URL aimed at the msw upstream: the
// local model is the OpenAI-compatible adapter with another base URL and no key.
describe("ollama provider", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  function start(): void {
    const config = loadConfig({
      ...TEST_ENV,
      PROVIDERS_ENABLED: "demo,ollama",
      OLLAMA_BASE_URL: UPSTREAM_BASE_URL,
    });
    const catalog = loadCatalog(config.modelCatalogPath);
    app = makeTestApp({
      db: testDb.db,
      config,
      catalog,
      registry: createRegistry(catalog, config, createAdapters(config)),
      operatorKeys: {},
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
});
