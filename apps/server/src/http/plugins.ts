import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
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

/** Response headers a browser script may read (the CORS safelisted ones need no listing). */
const EXPOSED_HEADERS = ["Location", "Retry-After", "Preference-Applied", "x-request-id"];
/** Request headers a browser script may send besides the safelisted ones. */
const ALLOWED_HEADERS = ["Content-Type", "Accept", "Prefer", "X-LLM-Api-Key", "x-request-id"];
const PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * Security headers on every response, and CORS for the listed origins (`*` for any; none:
 * no CORS headers at all). Both set headers in onRequest hooks, before any handler, so that
 * problem details, rate-limited answers and hijacked event streams carry them too (sse.ts
 * copies headers set before the hijack). Register before the rate limits.
 *
 * Helmet's default policy (V1 in #12): the API documentation at /docs loads only its own
 * scripts and styles from /docs/static, which `'self'` allows. `upgrade-insecure-requests` is
 * left out, since the API is also served over plain HTTP (locally and in compose), where it
 * would send the page's assets to an HTTPS port that does not exist.
 */
export function registerSecurityHeaders(app: FastifyInstance, corsOrigins: readonly string[]): void {
  if (corsOrigins.length > 0) {
    void app.register(fastifyCors, {
      origin: corsOrigins[0] === "*" ? "*" : [...corsOrigins],
      methods: ["GET", "HEAD", "POST", "PATCH", "DELETE"],
      allowedHeaders: ALLOWED_HEADERS,
      exposedHeaders: EXPOSED_HEADERS,
      // No cookies or other credentials are used: never allow them.
      credentials: false,
      maxAge: PREFLIGHT_MAX_AGE_SECONDS,
    });
  }
  void app.register(fastifyHelmet, {
    contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
  });
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
        description:
          "Multi-session chat API backed by large language models. No authentication: " +
          "anyone who can reach the API can read, change and delete any session. Every " +
          "route except /health and /health/ready is rate limited per client address " +
          "(RATE_LIMIT_GENERAL_PER_MIN, 120 a minute by default), and sends also have their " +
          "own budget (RATE_LIMIT_SEND_PER_MIN, 20 a minute); over a budget the answer is " +
          "429 problem details with code rate_limited and Retry-After (seconds). Request " +
          "bodies above 128 KiB answer 413.",
        version: "0.1.0",
      },
    },
    transform: transformKeepingResponseHeaders,
  });
  void app.register(fastifySwaggerUi, { routePrefix: "/docs" });

  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
}
