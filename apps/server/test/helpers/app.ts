import type { FastifyInstance } from "fastify";

import { type AppDeps, buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { type Db, createDb } from "../../src/db/client.js";
import { loadCatalog } from "../../src/llm/catalog.js";
import { DemoProvider } from "../../src/llm/demo.js";
import { createRegistry } from "../../src/llm/registry.js";

/** The environment test apps are configured from; spread it to change one value. */
export const TEST_ENV = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgres://unused@127.0.0.1:9/unused",
  FLUSH_INTERVAL_MS: "50",
  DEMO_DELAY_MS: "1",
} as const;

/**
 * A pool aimed at a closed local port. Tests that never touch the database use it; a test
 * that does gets a connection error. Unused pools hold no connections, so nothing to close.
 */
export function detachedDb(): Db {
  return createDb({
    connectionString: TEST_ENV.DATABASE_URL,
    connectionTimeoutMillis: 500,
    onPoolError: () => {},
  });
}

/**
 * Builds the app with test defaults: the shipped model catalog served by the real demo provider,
 * a detached database (pass `db` from useTestDatabase() for one that works). Tests register
 * extra routes before `ready()`.
 */
export function makeTestApp(overrides: Partial<AppDeps> = {}): FastifyInstance {
  const config = overrides.config ?? loadConfig(TEST_ENV);
  const catalog = overrides.catalog ?? loadCatalog(config.modelCatalogPath);
  return buildApp({
    config,
    catalog,
    registry:
      overrides.registry ??
      createRegistry(catalog, config, { demo: new DemoProvider({ delayMs: config.demoDelayMs }) }),
    db: overrides.db ?? detachedDb(),
    ...(overrides.logStream === undefined ? {} : { logStream: overrides.logStream }),
    ...(overrides.jobs === undefined ? {} : { jobs: overrides.jobs }),
  });
}
