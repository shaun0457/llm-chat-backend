import Fastify, { type FastifyInstance } from "fastify";

import { type AppDeps, buildApp } from "../../src/app.js";
import { type Clock, systemClock } from "../../src/clock.js";
import { type AppConfig, loadConfig } from "../../src/config.js";
import { type Db, createDb } from "../../src/db/client.js";
import { capacityFor } from "../../src/llm/capacity.js";
import { type ModelCatalog, loadCatalog } from "../../src/llm/catalog.js";
import { DemoProvider } from "../../src/llm/demo.js";
import { createRegistry } from "../../src/llm/registry.js";
import { type JobRegistry, createJobRegistry } from "../../src/modules/messages/jobs.js";

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

/** The operator key test apps have for the key-requiring "other" provider of testProviders(). */
export const TEST_OPERATOR_KEY = "test-operator-key-not-real";

/**
 * Builds the app with test defaults: the shipped model catalog served by the real demo provider,
 * a detached database (pass `db` from useTestDatabase() for one that works). Tests register
 * extra routes before `ready()`. `operatorKeys` replaces the configured operator keys; by
 * default "other" has TEST_OPERATOR_KEY, as if OTHER_API_KEY were set.
 */
export function makeTestApp(
  overrides: Partial<AppDeps> & { operatorKeys?: Readonly<Record<string, string>> } = {},
): FastifyInstance {
  const configured = overrides.config ?? loadConfig(TEST_ENV);
  const config = {
    ...configured,
    operatorKeys: overrides.operatorKeys ?? {
      other: TEST_OPERATOR_KEY,
      ...configured.operatorKeys,
    },
  };
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
    ...(overrides.clock === undefined ? {} : { clock: overrides.clock }),
  });
}

/**
 * A job registry a test holds on to (pass it as `jobs` to makeTestApp), to reach a running
 * generation or shut the registry down itself. Timing and capacity limits come from `config`
 * (TEST_ENV by default), provider limits also from the shipped catalog.
 */
export function testJobs(
  db: Db,
  options: {
    config?: AppConfig;
    catalog?: ModelCatalog;
    clock?: Clock;
    log?: FastifyInstance["log"];
  } = {},
): JobRegistry {
  const config = options.config ?? loadConfig(TEST_ENV);
  return createJobRegistry({
    db,
    timing: config,
    clock: options.clock ?? systemClock,
    log: options.log ?? Fastify({ logger: false }).log,
    capacity: capacityFor(config, options.catalog ?? loadCatalog(config.modelCatalogPath)),
  });
}
