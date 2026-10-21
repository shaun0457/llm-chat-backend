import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import type { ReadinessCheck } from "../../db/readiness.js";
import { ProblemError } from "../../http/problem-details.js";

const healthResponse = z.object({ status: z.literal("ok") });
const readyResponse = z.object({ status: z.literal("ready") });

export const healthRoutes: FastifyPluginAsyncZod<{ checkReadiness: ReadinessCheck }> = async (
  app,
  { checkReadiness },
) => {
  /** Liveness only: answers while the process can serve HTTP, checks no dependencies. */
  app.get(
    "/health",
    {
      schema: {
        summary: "Liveness probe",
        tags: ["health"],
        response: { 200: healthResponse },
      },
    },
    async () => ({ status: "ok" as const }),
  );

  app.get(
    "/health/ready",
    {
      schema: {
        summary: "Readiness probe",
        description:
          "200 when the database answers and its applied migrations match this build's. " +
          "Otherwise 503 not_ready, detail database_unreachable or migrations_pending.",
        tags: ["health"],
        response: { 200: readyResponse },
      },
    },
    async (request) => {
      const readiness = await checkReadiness(request.log);
      if (readiness !== "ready") {
        throw new ProblemError(503, "not_ready", readiness);
      }
      return { status: "ready" as const };
    },
  );
};
