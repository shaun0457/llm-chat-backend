import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

const healthResponse = z.object({ status: z.literal("ok") });

/** Liveness only: answers while the process can serve HTTP, checks no dependencies. */
export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
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
};
