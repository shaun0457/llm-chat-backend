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
import { registerApiDocs } from "./http/plugins.js";
import { registerProblemDetails, sendProblem, toProblem } from "./http/problem-details.js";
import type { ModelCatalog } from "./llm/catalog.js";
import type { ProviderRegistry } from "./llm/registry.js";
import { healthRoutes } from "./modules/health/routes.js";
import { createAttach } from "./modules/messages/attach.js";
import { type JobRegistry, createJobRegistry } from "./modules/messages/jobs.js";
import { findTurn } from "./modules/messages/repository.js";
import { messagesRoutes } from "./modules/messages/routes.js";
import { createMessagesService } from "./modules/messages/service.js";
import { providersRoutes } from "./modules/providers/routes.js";
import { sessionsRoutes } from "./modules/sessions/routes.js";
import { createSessionsService } from "./modules/sessions/service.js";
import { MIGRATIONS_FOLDER } from "./paths.js";

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

/** Returns a configured app that is not listening; only `server.ts` calls `listen`. */
export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, db, registry, logStream } = deps;
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: REDACTED_PATHS, censor: REDACTED },
      serializers: { err: serializeError },
      ...(logStream === undefined ? {} : { stream: logStream }),
    },
    requestIdHeader: false,
    genReqId: requestId,
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
  registerApiDocs(app);

  void app.register(healthRoutes, {
    checkReadiness: createReadinessCheck(db, MIGRATIONS_FOLDER),
  });
  void app.register(providersRoutes, { registry });
  const { staleThresholdMs } = config;
  void app.register(sessionsRoutes, {
    service: createSessionsService({ db, registry, staleThresholdMs }),
  });

  const clock = deps.clock ?? systemClock;
  const jobs = deps.jobs ?? createJobRegistry({ db, timing: config, clock, log: app.log });
  const messages = createMessagesService({
    db,
    registry,
    jobs,
    attach: createAttach({ jobs, readTurn: (assistantId) => findTurn(db.drizzle, assistantId) }),
    defaultSystemPrompt: config.defaultSystemPrompt,
    clock,
    staleThresholdMs,
    operatorKeys: config.operatorKeys,
  });
  void app.register(messagesRoutes, {
    service: messages,
    jsonWait: { defaultMs: config.jsonDefaultWaitMs, maxMs: config.jsonMaxWaitMs },
  });
  // Before the server stops accepting: running generations are aborted and store failed /
  // cancelled, so waiting responses finish instead of holding the close open.
  app.addHook("preClose", async () => {
    await jobs.shutdown(jobShutdownWaitMs(config));
  });

  return app;
}
