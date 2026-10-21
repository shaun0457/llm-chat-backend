import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import type { ProviderRegistry } from "../../llm/registry.js";

const providersResponse = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      requiresKey: z.boolean().describe("A key is needed: X-LLM-Api-Key or an operator key"),
      defaultModel: z.string(),
      models: z.array(
        z.object({
          id: z.string(),
          contextWindow: z.number().int().describe("Tokens, input and output together"),
          maxOutputTokens: z.number().int(),
        }),
      ),
    }),
  ),
});

export const providersRoutes: FastifyPluginAsyncZod<{ registry: ProviderRegistry }> = async (
  app,
  { registry },
) => {
  app.get(
    "/providers",
    {
      schema: {
        summary: "List enabled providers and their catalogued models",
        tags: ["providers"],
        response: { 200: providersResponse },
      },
    },
    async () => ({
      providers: registry.list().map((provider) => ({ ...provider, models: [...provider.models] })),
    }),
  );
};
