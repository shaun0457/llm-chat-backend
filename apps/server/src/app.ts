import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { type Clock, systemClock } from "./clock.js";
import type { AppConfig } from "./config.js";
import { REDACTED } from "./credentials/scrub.js";
import { serializeError } from "./credentials/serialize-error.js";
import type { Db } from "./db/client.js";
import { createReadinessCheck } from "./db/readiness.js";
import { registerApiDocs, registerRateLimits, registerSecurityHeaders } from "./http/plugins.js";
import { registerProblemDetails, sendProblem, toProblem } from "./http/problem-details.js";
import { capacityFor } from "./llm/capacity.js";
import type { ModelCatalog } from "./llm/catalog.js";
import type { ProviderRegistry } from "./llm/registry.js";
import { healthRoutes } from "./modules/health/routes.js";
import { createAttach } from "./modules/messages/attach.js";
import { type JobRegistry, createJobRegistry } from "./modules/messages/jobs.js";
import { findTurn } from "./modules/messages/repository.js";
import { messagesRoutes } from "./modules/messages/routes.js";
import { createMessagesService } from "./modules/messages/service.js";
import { providersRoutes } from "./modules/providers/routes.js";
import { type Retention, createRetention } from "./modules/sessions/retention.js";
import { sessionsRoutes } from "./modules/sessions/routes.js";
import { createSessionsService } from "./modules/sessions/service.js";
import { MIGRATIONS_FOLDER } from "./paths.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Deletes inactive sessions; null unless RETENTION_DAYS is set. Tests call runOnce(). */
    retention: Retention | null;
  }
}

/** The app never closes `db`: its owner does (server.ts on shutdown, the test harness per file). */
export type AppDeps = {
  config: AppConfig;
  db: Db;
  catalog: ModelCatalog;
  registry: ProviderRegistry;
  logStream?: NodeJS.WritableStream;
  /** Replaces the app's own job registry, so a test can subscribe to a running generation. */
  jobs?: JobRegistry;
  /** Monotonic time for deadlines and budgets; tests inject a controllable one. */
  clock?: Clock;
};

const REQUEST_ID_HEADER = "x-request-id";
/** Request bodies above this answer 413 before they are parsed (Fastify's default: 1 MiB). */
export const BODY_LIMIT_BYTES = 131_072;
/** Time for providers to honour the abort before the job's terminal write starts. */
const JOB_STOP_GRACE_MS = 1_000;

/**
 * How long closing the app waits for aborted generations to store their final state: a grace
 * for providers to stop, one statement timeout for a flush still in flight, and the whole
 * terminal-write budget. server.ts's forced-exit timeout is longer still. Rows not stored in
 * time are left for stale reclaim.
 */
export function jobShutdownWaitMs(
  config: Pick<AppConfig, "terminalStatementTimeoutMs" | "terminalWriteBudgetMs">,
): number {
  return JOB_STOP_GRACE_MS + config.terminalStatementTimeoutMs + config.terminalWriteBudgetMs;
}
const VALID_REQUEST_ID = /^[\x21-\x7e]{1,128}$/;

/**
 * Credential headers when a request's headers are logged as `headers` or `req.headers`, and
 * `apiKey` fields up to three levels deep. Errors are covered by the `err` serializer, which
 * writes allowlisted fields only.
 */
const REDACTED_PATHS = [
  "apiKey",
  "*.apiKey",
  "*.*.apiKey",
  'req.headers["x-llm-api-key"]',
  "req.headers.authorization",
  'req.headers["proxy-authorization"]',
  "req.headers.cookie",
  'headers["x-llm-api-key"]',
  "headers.authorization",
  'headers["proxy-authorization"]',
  "headers.cookie",
];

function requestId(request: IncomingMessage): string {
  const incoming = request.headers[REQUEST_ID_HEADER];
  return typeof incoming === "string" && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

/**
 * Node server options that make REQUEST_TIMEOUT_MS the bound for receiving a whole request.
 * Node 22 checks open requests only every `connectionsCheckingInterval` (30 s by default), and
 * a request whose headers have arrived but whose body stalls is ended only after
 * `headersTimeout` (60 s by default), whatever `requestTimeout` says (measured). So both
 * follow the timeout: a stalled request gets 408 within the timeout plus a tenth of it.
 */
export function requestTimeoutOptions(requestTimeoutMs: number) {
  return {
    requestTimeout: requestTimeoutMs,
    headersTimeout: requestTimeoutMs,
    connectionsCheckingInterval: Math.min(30_000, Math.max(100, Math.floor(requestTimeoutMs / 10))),
  };
}

/** Returns a configured app that is not listening; only `server.ts` calls `listen`. */
export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, db, catalog, registry, logStream } = deps;
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: REDACTED_PATHS, censor: REDACTED },
      serializers: { err: serializeError },
      ...(logStream === undefined ? {} : { stream: logStream }),
    },
    requestIdHeader: false,
    genReqId: requestId,
    // request.ip: the socket's address, or, from a listed proxy, the nearest X-Forwarded-For
    // address that is not itself a listed proxy (read right to left).
    trustProxy: config.trustProxy === undefined ? false : [...config.trustProxy],
    // Bounds receiving a request (slow headers or body end with 408), never a response: SSE
    // streams and long JSON waits are unaffected (V3 of #2). The socket inactivity timeout
    // stays 0.
    requestTimeout: config.requestTimeoutMs,
    http: requestTimeoutOptions(config.requestTimeoutMs),
    // A send's 16,000 characters fit with room to spare, even if all escaped as \uXXXX.
    bodyLimit: BODY_LIMIT_BYTES,
    // Errors raised before routing (e.g. an undecodable URL) bypass hooks and the error handler.
    frameworkErrors: (error, request, reply) => {
      void reply.header(REQUEST_ID_HEADER, request.id);
      return sendProblem(reply, toProblem(error, request.log));
    },
  });

  app.addHook("onRequest", async (request, reply) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
  });

  // Valid (a platform proxy may require a short wait), but worth knowing when reading 202s.
  const generationLimitMs = config.generationDeadlineMs + config.terminalWriteBudgetMs;
  if (config.jsonMaxWaitMs < generationLimitMs) {
    app.log.info(
      { jsonMaxWaitMs: config.jsonMaxWaitMs, generationLimitMs },
      "JSON_MAX_WAIT_MS is below the generation deadline plus the terminal-write budget; " +
        "JSON clients may get 202 for long answers and should poll",
    );
  }

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerProblemDetails(app);
  registerSecurityHeaders(app, config.corsOrigins);
  registerRateLimits(app, config.rateLimitGeneralPerMin);
  registerApiDocs(app);

  void app.register(healthRoutes, {
    checkReadiness: createReadinessCheck(db, MIGRATIONS_FOLDER),
  });
  void app.register(providersRoutes, { registry });
  const { staleThresholdMs } = config;
  const clock = deps.clock ?? systemClock;
  const jobs =
    deps.jobs ??
    createJobRegistry({
      db,
      timing: config,
      clock,
      log: app.log,
      capacity: capacityFor(config, catalog),
    });
  const sessions = createSessionsService({ db, registry, staleThresholdMs, jobs });
  void app.register(sessionsRoutes, { service: sessions });

  const retention =
    config.retentionDays === undefined
      ? null
      : createRetention({
          db,
          sessions,
          days: config.retentionDays,
          intervalMs: config.retentionIntervalMs,
          log: app.log,
        });
  app.decorate("retention", retention);
  if (retention !== null) {
    // Only a listening server runs it: tests and the OpenAPI script build apps that never do.
    app.addHook("onListen", async () => {
      retention.start();
    });
    app.addHook("preClose", async () => {
      await retention.stop();
    });
  }

  const messages = createMessagesService({
    db,
    registry,
    jobs,
    attach: createAttach({
      jobs,
      readTurn: (assistantId) => findTurn(db.drizzle, assistantId),
      log: app.log,
    }),
    defaultSystemPrompt: config.defaultSystemPrompt,
    clock,
    staleThresholdMs,
    operatorKeys: config.operatorKeys,
  });
  void app.register(messagesRoutes, {
    service: messages,
    jsonWait: { defaultMs: config.jsonDefaultWaitMs, maxMs: config.jsonMaxWaitMs },
    sse: config,
    sendsPerMinute: config.rateLimitSendPerMin,
  });
  // Before the server stops accepting: running generations are aborted and store failed /
  // cancelled, so waiting responses finish instead of holding the close open.
  app.addHook("preClose", async () => {
    await jobs.shutdown(jobShutdownWaitMs(config));
  });

  return app;
}
