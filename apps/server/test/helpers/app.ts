import type { FastifyInstance } from "fastify";

import { type AppDeps, buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

/** Builds the app with test defaults; tests register extra routes before calling `ready()`. */
export function makeTestApp(overrides: Partial<AppDeps> = {}): FastifyInstance {
  return buildApp({
    config: loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
    ...overrides,
  });
}
