import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { AppConfig } from "./config.js";
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
};

const REQUEST_ID_HEADER = "x-request-id";
/** How long closing the app waits for aborted generations; below server.ts's shutdown timeout. */
const JOB_SHUTDOWN_WAIT_MS = 5_000;
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
  const { config, db, catalog, registry, logStream } = deps;
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: REDACTED_PATHS, censor: "[REDACTED]" },
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

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerProblemDetails(app);
  registerApiDocs(app);

  void app.register(healthRoutes, {
    checkReadiness: createReadinessCheck(db, MIGRATIONS_FOLDER),
  });
  void app.register(providersRoutes, { registry });
  void app.register(sessionsRoutes, { service: createSessionsService({ db, registry }) });

  const jobs =
    deps.jobs ?? createJobRegistry({ db, flushIntervalMs: config.flushIntervalMs, log: app.log });
  const messages = createMessagesService({
    db,
    registry,
    catalog,
    jobs,
    attach: createAttach({ jobs, readTurn: (assistantId) => findTurn(db.drizzle, assistantId) }),
    defaultSystemPrompt: config.defaultSystemPrompt,
    operatorKeys: config.operatorKeys,
  });
  void app.register(messagesRoutes, {
    service: messages,
    jsonWait: { defaultMs: config.jsonDefaultWaitMs, maxMs: config.jsonMaxWaitMs },
  });
  // Before the server stops accepting: running generations end, so waiting responses finish
  // instead of holding the close open. An aborted row stays generating for now.
  app.addHook("preClose", async () => {
    await jobs.shutdown(JOB_SHUTDOWN_WAIT_MS);
  });

  return app;
}
