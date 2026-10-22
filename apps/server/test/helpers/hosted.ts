import type { FastifyInstance } from "fastify";

import { type AppConfig, loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db/client.js";
import { loadCatalog } from "../../src/llm/catalog.js";
import { DemoProvider } from "../../src/llm/demo.js";
import { OpenAiCompatibleProvider } from "../../src/llm/openai-compatible.js";
import { createRegistry } from "../../src/llm/registry.js";
import { TEST_ENV, makeTestApp } from "./app.js";
import { UPSTREAM_BASE_URL } from "./msw-openai.js";

/**
 * The app with the shipped catalog and the real OpenAI-compatible adapter serving "nvidia",
 * pointed at the msw upstream (see useUpstream). No operator key unless `operatorKeys` says so.
 */
export function makeHostedTestApp(options: {
  db: Db;
  env?: Record<string, string>;
  logStream?: NodeJS.WritableStream;
  operatorKeys?: Record<string, string>;
}): FastifyInstance {
  const config: AppConfig = loadConfig({
    ...TEST_ENV,
    PROVIDERS_ENABLED: "demo,nvidia",
    ...options.env,
  });
  const catalog = loadCatalog(config.modelCatalogPath);
  const registry = createRegistry(catalog, config, {
    demo: new DemoProvider({ delayMs: config.demoDelayMs }),
    nvidia: new OpenAiCompatibleProvider({ id: "nvidia", baseUrl: UPSTREAM_BASE_URL }),
  });
  return makeTestApp({
    db: options.db,
    config,
    catalog,
    registry,
    operatorKeys: options.operatorKeys ?? {},
    ...(options.logStream === undefined ? {} : { logStream: options.logStream }),
  });
}
