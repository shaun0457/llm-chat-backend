import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider } from "../helpers/fake-llm.js";
import { allMessages, createSession, getSession, send } from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";

const testDb = useTestDatabase();

// Providers: demo (keyless, model "demo"), other (needs a key, which the test app has;
// o-small and o-large, default o-large), off (catalogued, not enabled).
describe("overrides: per-message provider and model", () => {
  let app: FastifyInstance;
  let fake: FakeLlmProvider;

  beforeEach(() => {
    fake = new FakeLlmProvider();
    app = makeTestApp({ db: testDb.db, ...testProviders({ llm: fake }) });
  });
  afterEach(async () => {
    await app.close();
  });

  it.each([
    [
      "model only: the session's provider with that model",
      { provider: "other", model: "o-large" },
      { model: "o-small" },
      { provider: "other", model: "o-small", maxOutputTokens: 512 },
    ],
    [
      "provider only: that provider's default model",
      {},
      { provider: "other" },
      { provider: "other", model: "o-large", maxOutputTokens: 4096 },
    ],
    [
      "provider only, the session's own provider: its default model",
      { provider: "other", model: "o-small" },
      { provider: "other" },
      { provider: "other", model: "o-large", maxOutputTokens: 4096 },
    ],
    [
      "both: as given",
      {},
      { provider: "other", model: "o-small" },
      { provider: "other", model: "o-small", maxOutputTokens: 512 },
    ],
    [
      "neither: the session's provider and model",
      { provider: "other", model: "o-small" },
      {},
      { provider: "other", model: "o-small", maxOutputTokens: 512 },
    ],
  ])("resolves %s, frozen on the assistant row", async (_name, sessionPair, override, used) => {
    const session = await createSession(app, sessionPair);

    const response = await send(app, session.id, { content: "Hi", ...override });

    expect(response.statusCode).toBe(200);
    expect(response.json().assistantMessage).toMatchObject({
      status: "completed",
      provider: used.provider,
      model: used.model,
    });
    expect(fake.requests[0]).toMatchObject({
      model: used.model,
      maxOutputTokens: used.maxOutputTokens,
    });
  });

  it("leaves the session's defaults unchanged, so the next turn uses them again", async () => {
    const session = await createSession(app);

    await send(app, session.id, { content: "One", provider: "other", model: "o-small" });

    expect(await getSession(app, session.id)).toMatchObject({ provider: "demo", model: "demo" });
    const next = await send(app, session.id, { content: "Two" });
    expect(next.json().assistantMessage).toMatchObject({ provider: "demo", model: "demo" });
    const [, first] = await allMessages(app, session.id);
    expect(first).toMatchObject({ provider: "other", model: "o-small" });
  });

  it.each([
    ["an unknown provider", { provider: "nope" }, "provider_unavailable"],
    ["a provider that is not enabled", { provider: "off" }, "provider_unavailable"],
    ["a model the session's provider lacks", { model: "o-small" }, "model_not_supported"],
    ["a pair that does not match", { provider: "demo", model: "o-small" }, "model_not_supported"],
  ])("rejects %s with 422 and writes nothing", async (_name, override, code) => {
    const session = await createSession(app);

    const response = await send(app, session.id, { content: "Hi", ...override });

    expect(response.statusCode).toBe(422);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({ status: 422, code });
    expect(await allMessages(app, session.id)).toEqual([]);
    expect(await getSession(app, session.id)).toEqual(session);
    expect(fake.requests).toHaveLength(0);
  });

  it("decides the credential for the overriding provider", async () => {
    await app.close();
    app = makeTestApp({ db: testDb.db, operatorKeys: {}, ...testProviders({ llm: fake }) });
    const session = await createSession(app);

    const response = await send(app, session.id, { content: "Hi", provider: "other" });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "llm_credential_missing" });
    expect(await allMessages(app, session.id)).toEqual([]);
  });

  it.each([
    ["an empty provider", { provider: "" }, "body.provider"],
    ["a null model", { model: null }, "body.model"],
    ["a non-string provider", { provider: 42 }, "body.provider"],
  ])("rejects %s with 400 validation_error", async (_name, override, field) => {
    const session = await createSession(app);

    const response = await send(app, session.id, { content: "Hi", ...override });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "validation_error" });
    expect(response.json().detail).toContain(field);
  });
});
