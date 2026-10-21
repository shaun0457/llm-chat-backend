import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

import type { AppConfig } from "./config.js";
import { registerProblemDetails } from "./http/problem-details.js";
import { healthRoutes } from "./modules/health/routes.js";

export type AppDeps = {
  config: AppConfig;
  logStream?: NodeJS.WritableStream;
};

/** Returns a configured app that is not listening; only `server.ts` calls `listen`. */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerProblemDetails(app);

  void app.register(healthRoutes);

  return app;
}
