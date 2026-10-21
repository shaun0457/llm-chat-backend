import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "./config.js";
import { registerApiDocs } from "./http/plugins.js";
import { registerProblemDetails } from "./http/problem-details.js";
import { healthRoutes } from "./modules/health/routes.js";

export type AppDeps = {
  config: AppConfig;
  logStream?: NodeJS.WritableStream;
};

const REQUEST_ID_HEADER = "x-request-id";
const VALID_REQUEST_ID = /^[\x21-\x7e]{1,128}$/;

/** Credential headers, wherever a request's headers end up in a log object. */
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
