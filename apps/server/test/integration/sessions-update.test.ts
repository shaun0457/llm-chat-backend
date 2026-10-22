import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { testProviders } from "../helpers/providers.js";

const testDb = useTestDatabase();

type Session = {
  id: string;
  title: string | null;
  provider: string;
  model: string;
  systemPrompt: string | null;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
};

// Providers: demo (default, model "demo"), other (o-small, o-large; default o-large), off (disabled).
describe("PATCH /sessions/:id", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = makeTestApp({ db: testDb.db, ...testProviders() });
  });
  afterEach(async () => {
    await app.close();
  });

  async function createSession(payload: Record<string, unknown> = {}): Promise<Session> {
    const response = await app.inject({ method: "POST", url: "/sessions", payload });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  const patch = (id: string, payload?: unknown) =>
    app.inject({
      method: "PATCH",
      url: `/sessions/${id}`,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  it("changes the title and moves updatedAt but not lastActivityAt", async () => {
    const session = await createSession({ title: "Before" });

    const response = await patch(session.id, { title: "After" });

    expect(response.statusCode).toBe(200);
    const updated: Session = response.json();
    expect(updated).toMatchObject({
      id: session.id,
      title: "After",
      provider: "demo",
      model: "demo",
    });
    expect(updated.lastActivityAt).toBe(session.lastActivityAt);
    expect(updated.createdAt).toBe(session.createdAt);
    expect(updated.updatedAt > session.updatedAt).toBe(true);

    const read = await app.inject({ method: "GET", url: `/sessions/${session.id}` });
    expect(read.json()).toEqual(updated);
  });

  it("clears the title and the system prompt with null", async () => {
    const session = await createSession({ title: "Titled", systemPrompt: "Be brief." });

    const response = await patch(session.id, { title: null, systemPrompt: null });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ title: null, systemPrompt: null });
  });

  it("sets a system prompt", async () => {
    const session = await createSession();

    const response = await patch(session.id, { systemPrompt: "Answer in French." });

    expect(response.json()).toMatchObject({ systemPrompt: "Answer in French." });
  });

  it("takes the new provider's default model when only the provider changes", async () => {
    const session = await createSession();

    const response = await patch(session.id, { provider: "other" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ provider: "other", model: "o-large" });
  });

  it("takes the provider's default model even when the request repeats the current provider", async () => {
    const session = await createSession({ provider: "other", model: "o-small" });

    const response = await patch(session.id, { title: "x", provider: "other" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ provider: "other", model: "o-large" });
  });

  it("keeps the model when the request omits the provider", async () => {
    const session = await createSession({ provider: "other", model: "o-small" });

    const response = await patch(session.id, { title: "x" });

    expect(response.json()).toMatchObject({ provider: "other", model: "o-small" });
  });

  it("keeps the provider when only the model changes", async () => {
    const session = await createSession({ provider: "other" });

    const response = await patch(session.id, { model: "o-small" });

    expect(response.json()).toMatchObject({ provider: "other", model: "o-small" });
  });

  it("never moves lastActivityAt, whatever changes", async () => {
    const session = await createSession();

    await patch(session.id, { title: "One" });
    await patch(session.id, { provider: "other", model: "o-small" });
    const last = await patch(session.id, { systemPrompt: "x", title: null });

    expect(last.json().lastActivityAt).toBe(session.lastActivityAt);
  });

  it.each([
    ["an unknown provider", { provider: "nope" }, "provider_unavailable"],
    ["a disabled provider", { provider: "off" }, "provider_unavailable"],
    ["a model of another provider", { model: "o-small" }, "model_not_supported"],
    ["a pair that does not match", { provider: "other", model: "demo" }, "model_not_supported"],
  ])("rejects %s with 422 and changes nothing", async (_name, payload, code) => {
    const session = await createSession({ title: "Unchanged" });

    const response = await patch(session.id, { ...payload, title: "Changed" });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ status: 422, code });
    const read = await app.inject({ method: "GET", url: `/sessions/${session.id}` });
    expect(read.json()).toEqual(session);
  });

  it.each([
    ["no body", undefined],
    ["an empty object", {}],
    ["only unknown fields", { colour: "blue" }],
  ])("rejects %s with 400 validation_error", async (_name, payload) => {
    const session = await createSession();

    const response = await patch(session.id, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "validation_error" });
  });

  it.each([
    ["a blank title", { title: "  " }, "body.title"],
    ["a null provider", { provider: null }, "body.provider"],
    ["a null model", { model: null }, "body.model"],
    [
      "a system prompt over 8,000 characters",
      { systemPrompt: "x".repeat(8001) },
      "body.systemPrompt",
    ],
  ])("rejects %s with 400 validation_error", async (_name, payload, field) => {
    const session = await createSession();

    const response = await patch(session.id, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toContain(field);
  });

  it("answers an unknown id with 404 session_not_found", async () => {
    const response = await patch("01900000-0000-7000-8000-000000000000", { title: "x" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "session_not_found" });
  });
});
