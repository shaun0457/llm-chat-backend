import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { AppConfig } from "./config.js";
import { registerApiDocs } from "./http/plugins.js";
import { problem, registerProblemDetails, sendProblem } from "./http/problem-details.js";
import { healthRoutes } from "./modules/health/routes.js";

export type AppDeps = {
  config: AppConfig;
  logStream?: NodeJS.WritableStream;
};

const REQUEST_ID_HEADER = "x-request-id";
const VALID_REQUEST_ID = /^[\x21-\x7e]{1,128}$/;

/**
 * Credential headers when a request's headers are logged as `headers` or `req.headers`.
 * Not covered: headers nested in error objects (e.g. an upstream SDK error); the credentials
 * ticket adds error scrubbing.
 */
const REDACTED_PATHS = [
  'req.headers["x-llm-api-key"]',
  "req.headers.authorization",
  'headers["x-llm-api-key"]',
  "headers.authorization",
];

function requestId(request: IncomingMessage): string {
  const incoming = request.headers[REQUEST_ID_HEADER];
  return typeof incoming === "string" && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

/** Returns a configured app that is not listening; only `server.ts` calls `listen`. */
export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, logStream } = deps;
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: REDACTED_PATHS, censor: "[REDACTED]" },
      ...(logStream === undefined ? {} : { stream: logStream }),
    },
    requestIdHeader: false,
    genReqId: requestId,
    // Errors raised before routing (e.g. an undecodable URL) bypass hooks and the error handler.
    frameworkErrors: (error, request, reply) => {
      void reply.header(REQUEST_ID_HEADER, request.id);
      return sendProblem(reply, problem(400, "validation_error", error.message));
    },
  });

  app.addHook("onRequest", async (request, reply) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerProblemDetails(app);
  registerApiDocs(app);

  void app.register(healthRoutes);

  return app;
}
