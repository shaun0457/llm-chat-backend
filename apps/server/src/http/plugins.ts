import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import { jsonSchemaTransform } from "fastify-type-provider-zod";

type Transform = typeof jsonSchemaTransform;

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
  const declared: unknown = document.schema.response;
  const transformed: unknown = result.schema.response;
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
        description: "Multi-session chat API backed by large language models.",
        version: "0.1.0",
      },
    },
    transform: transformKeepingResponseHeaders,
  });
  void app.register(fastifySwaggerUi, { routePrefix: "/docs" });

  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
}
