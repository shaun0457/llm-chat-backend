import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { makeTestApp } from "../helpers/app.js";
import { testProviders } from "../helpers/providers.js";

describe("GET /providers", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("lists the keyless demo provider with its default model and catalog entries", async () => {
    app = makeTestApp();

    const response = await app.inject({ method: "GET", url: "/providers" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      providers: [
        {
          id: "demo",
          requiresKey: false,
          defaultModel: "demo",
          models: [{ id: "demo", contextWindow: 8192, maxOutputTokens: 1024 }],
        },
      ],
    });
  });

  it("lists only enabled providers, in order, with no other fields", async () => {
    app = makeTestApp(testProviders());

    const response = await app.inject({ method: "GET", url: "/providers" });

    const { providers } = response.json() as { providers: Array<Record<string, unknown>> };
    expect(providers.map((provider) => provider.id)).toEqual(["demo", "other"]);
    for (const provider of providers) {
      expect(Object.keys(provider).sort()).toEqual(["defaultModel", "id", "models", "requiresKey"]);
    }
    expect(providers[1]).toMatchObject({ requiresKey: true, defaultModel: "o-large" });
  });
});
