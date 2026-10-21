import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import { jsonSchemaTransform } from "fastify-type-provider-zod";

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
    transform: jsonSchemaTransform,
  });
  void app.register(fastifySwaggerUi, { routePrefix: "/docs" });

  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
}
