import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { testProviders } from "../helpers/providers.js";

const testDb = useTestDatabase();

// Providers: demo (default, model "demo"), other (models o-small, o-large; default o-large),
// off (catalogued, not enabled).
describe("session provider and model resolution", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = makeTestApp({ db: testDb.db, ...testProviders() });
  });
  afterEach(async () => {
    await app.close();
  });

  const create = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/sessions", payload });

  it.each([
    ["provider and model", { provider: "other", model: "o-small" }, "other", "o-small"],
    ["provider only: its default model", { provider: "other" }, "other", "o-large"],
    ["model only: the default provider", { model: "demo" }, "demo", "demo"],
  ])("creates with %s", async (_name, payload, provider, model) => {
    const response = await create(payload);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ provider, model });
  });

  it.each([
    ["an unknown provider", { provider: "nope" }],
    ["a catalogued provider that is not enabled", { provider: "off", model: "off-1" }],
  ])("rejects %s with 422 provider_unavailable", async (_name, payload) => {
    const response = await create(payload);

    expect(response.statusCode).toBe(422);
    expect(response.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(response.json()).toMatchObject({ status: 422, code: "provider_unavailable" });
  });

  it.each([
    ["a model of another provider", { provider: "other", model: "demo" }],
    ["a model only, not in the default provider's catalog", { model: "o-small" }],
    ["an unknown model", { provider: "demo", model: "nope" }],
  ])("rejects %s with 422 model_not_supported", async (_name, payload) => {
    const response = await create(payload);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ status: 422, code: "model_not_supported" });
  });

  it("stores nothing when the pair is rejected", async () => {
    const before = await app.inject({ method: "GET", url: "/sessions?limit=100" });

    await create({ provider: "nope" });

    const after = await app.inject({ method: "GET", url: "/sessions?limit=100" });
    expect(after.json().items).toHaveLength(before.json().items.length);
  });
});
