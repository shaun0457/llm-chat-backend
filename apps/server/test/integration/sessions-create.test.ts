import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";

const testDb = useTestDatabase();

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_UTC_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const PROBLEM_JSON = /^application\/problem\+json/;

describe("POST /sessions and GET /sessions/:id", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = makeTestApp({ db: testDb.db });
  });
  afterEach(async () => {
    await app.close();
  });

  it("creates a session from an empty body with the configured defaults", async () => {
    const response = await app.inject({ method: "POST", url: "/sessions" });

    expect(response.statusCode).toBe(201);
    const session = response.json();
    expect(session).toEqual({
      id: expect.stringMatching(UUID_V7),
      title: null,
      provider: "demo",
      model: "demo",
      systemPrompt: null,
      lastActivityAt: expect.stringMatching(ISO_UTC_MICROS),
      createdAt: expect.stringMatching(ISO_UTC_MICROS),
      updatedAt: expect.stringMatching(ISO_UTC_MICROS),
    });
    expect(response.headers.location).toBe(`/sessions/${session.id}`);
    expect(session.lastActivityAt).toBe(session.createdAt);
    expect(session.updatedAt).toBe(session.createdAt);
  });

  it("treats an empty JSON object like an empty body", async () => {
    const response = await app.inject({ method: "POST", url: "/sessions", payload: {} });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ title: null, provider: "demo", model: "demo" });
  });

  it("stores the given title and system prompt", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { title: "Trip planning", systemPrompt: "You are terse." },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      title: "Trip planning",
      systemPrompt: "You are terse.",
    });
  });

  it("reads a session back exactly as it was created", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { title: "Read me" },
    });

    const response = await app.inject({ method: "GET", url: created.headers.location as string });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(created.json());
  });

  it("answers an unknown id with 404 session_not_found", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/sessions/01900000-0000-7000-8000-000000000000",
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(response.json()).toMatchObject({ status: 404, code: "session_not_found" });
  });

  it("answers a malformed id with 400 validation_error", async () => {
    const response = await app.inject({ method: "GET", url: "/sessions/not-a-uuid" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "validation_error" });
    expect(response.json().detail).toContain("params.id");
  });

  describe("field limits", () => {
    it.each([
      ["an empty title", { title: "" }, "body.title"],
      ["a whitespace-only title", { title: " \t\n" }, "body.title"],
      ["a title over 200 characters", { title: "x".repeat(201) }, "body.title"],
      ["an empty system prompt", { systemPrompt: "" }, "body.systemPrompt"],
      [
        "a system prompt over 8,000 characters",
        { systemPrompt: "x".repeat(8001) },
        "body.systemPrompt",
      ],
      ["a non-string provider", { provider: 42 }, "body.provider"],
    ])("rejects %s with 400 validation_error", async (_name, payload, field) => {
      const response = await app.inject({ method: "POST", url: "/sessions", payload });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "validation_error" });
      expect(response.json().detail).toContain(field);
    });

    it("accepts the longest allowed title and system prompt, untrimmed", async () => {
      const title = ` ${"x".repeat(198)} `;
      const systemPrompt = "y".repeat(8000);

      const response = await app.inject({
        method: "POST",
        url: "/sessions",
        payload: { title, systemPrompt },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ title, systemPrompt });
    });
  });
});
