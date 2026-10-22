import fastifyRateLimit from "@fastify/rate-limit";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { jsonSchemaTransform } from "fastify-type-provider-zod";

import { ProblemError } from "./problem-details.js";

type Transform = typeof jsonSchemaTransform;

const ONE_MINUTE_MS = 60_000;

/**
 * One rate-limit budget: a fixed one-minute window per client address (`request.ip`, IPv6
 * grouped by /64), in this process's memory. Throws 429 rate_limited with Retry-After once
 * the address has used it up. Routes that share one policy object share its counter.
 */
export type RateLimitPolicy = (request: FastifyRequest) => Promise<void>;

/**
 * A new, independent budget of `perMinute` requests. Call only once registerRateLimits' plugin
 * has loaded, e.g. inside a route plugin registered after it.
 *
 * Built on @fastify/rate-limit's `createRateLimit` (its store and address handling) rather
 * than its route hooks: a request passes only the first of those hooks (the plugin marks it
 * as checked), and a route's own `config.rateLimit` replaces the global one. Policies applied
 * as separate hooks hold together instead (V2 in #12).
 */
export function rateLimitPolicy(app: FastifyInstance, perMinute: number): RateLimitPolicy {
  const check = app.createRateLimit({ max: perMinute, timeWindow: ONE_MINUTE_MS });
  return async (request) => {
    const result = await check(request);
    if (!result.isAllowed && result.isExceeded) {
      const seconds = String(Math.max(1, result.ttlInSeconds));
      throw new ProblemError(
        429,
        "rate_limited",
        `Too many requests from this address; try again in ${seconds} s`,
        undefined,
        { "retry-after": seconds },
      );
    }
  };
}

/** Health checks are never limited: the platform polls them. */
function isHealthCheck(request: FastifyRequest): boolean {
  return request.routeOptions.url?.startsWith("/health") === true;
}

/**
 * The general per-address limit on every request (unknown routes included) except the health
 * checks. Register before the routes; route-specific budgets (sends) add their own policy.
 */
export function registerRateLimits(app: FastifyInstance, generalPerMinute: number): void {
  void app.register(fastifyRateLimit, { global: false });
  app.after(() => {
    const general = rateLimitPolicy(app, generalPerMinute);
    app.addHook("onRequest", async (request) => {
      if (!isHealthCheck(request)) {
        await general(request);
      }
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * jsonSchemaTransform keeps only `description` and `content` of a response written as
 * `{ description, headers, content }`; this puts its documented `headers` (plain JSON Schemas)
 * back, which @fastify/swagger turns into OpenAPI response headers.
 */
const transformKeepingResponseHeaders: Transform = (document) => {
  const result = jsonSchemaTransform(document);
  // A route without a schema has none at run time, whatever the type says.
  const schema: unknown = document.schema;
  const declared: unknown = isRecord(schema) ? schema.response : undefined;
  const transformed: unknown = isRecord(result.schema) ? result.schema.response : undefined;
  if (isRecord(declared) && isRecord(transformed)) {
    for (const [status, response] of Object.entries(declared)) {
      const target = transformed[status];
      if (isRecord(response) && isRecord(response.headers) && isRecord(target)) {
        target.headers = response.headers;
      }
    }
  }
  return result;
};

/**
 * OpenAPI generated from the zod route schemas (no hand-written JSON Schema).
 * Must be registered before any route so swagger's onRoute hook sees them.
 */
export function registerApiDocs(app: FastifyInstance): void {
  void app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "LLM Chat Backend",
        description: "Multi-session chat API backed by large language models.",
        version: "0.1.0",
      },
    },
    transform: transformKeepingResponseHeaders,
  });
  void app.register(fastifySwaggerUi, { routePrefix: "/docs" });

  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
}
