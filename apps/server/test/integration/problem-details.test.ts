import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { ProblemError } from "../../src/http/problem-details.js";
import { makeTestApp } from "../helpers/app.js";

const PROBLEM_JSON = /^application\/problem\+json/;

describe("problem details", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("answers an unknown route with 404 route_not_found", async () => {
    app = makeTestApp();

    const response = await app.inject({ method: "GET", url: "/nope" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(response.json()).toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      code: "route_not_found",
      detail: "GET /nope does not exist",
    });
  });

  it("answers an invalid body with 400 validation_error naming the field path", async () => {
    app = makeTestApp();
    app
      .withTypeProvider<ZodTypeProvider>()
      .post(
        "/test/echo",
        { schema: { body: z.object({ content: z.string() }) } },
        async (request) => request.body,
      );

    const response = await app.inject({ method: "POST", url: "/test/echo", payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toMatch(PROBLEM_JSON);
    const body = response.json();
    expect(body).toMatchObject({
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      code: "validation_error",
    });
    expect(body.detail).toContain("body.content");
  });

  it("answers malformed JSON with 400 validation_error", async () => {
    app = makeTestApp();
    app.post("/test/echo", async (request) => request.body);

    const response = await app.inject({
      method: "POST",
      url: "/test/echo",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(response.json()).toMatchObject({ status: 400, code: "validation_error" });
  });

  it("passes an expected ProblemError through with its status, code and detail", async () => {
    app = makeTestApp();
    app.get("/test/conflict", async () => {
      throw new ProblemError(409, "session_busy", "An answer is still being generated");
    });

    const response = await app.inject({ method: "GET", url: "/test/conflict" });

    expect(response.statusCode).toBe(409);
    expect(response.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(response.json()).toEqual({
      type: "about:blank",
      title: "Conflict",
      status: 409,
      code: "session_busy",
      detail: "An answer is still being generated",
    });
  });

  it("hides an unexpected error behind 500 internal_error", async () => {
    app = makeTestApp();
    app.get("/test/boom", async () => {
      throw new Error("database password is hunter2");
    });

    const response = await app.inject({ method: "GET", url: "/test/boom" });

    expect(response.statusCode).toBe(500);
    expect(response.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(response.json()).toEqual({
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      code: "internal_error",
    });
    expect(response.body).not.toContain("hunter2");
    expect(response.body).not.toContain("at ");
  });

  it("does not pass through the status or message of a non-framework error", async () => {
    app = makeTestApp();
    app.get("/test/upstream", async () => {
      throw Object.assign(new Error("upstream said: key sk-123 is rate limited"), {
        statusCode: 429,
      });
    });

    const response = await app.inject({ method: "GET", url: "/test/upstream" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "internal_error" });
    expect(response.body).not.toContain("sk-123");
  });

  it("hides a thrown non-Error value behind 500 internal_error", async () => {
    app = makeTestApp();
    app.get("/test/null", async () => {
      throw null;
    });

    const response = await app.inject({ method: "GET", url: "/test/null" });

    expect(response.statusCode).toBe(500);
    expect(response.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(response.json()).toMatchObject({ code: "internal_error" });
  });

  it("keeps a plugin's deliberate client error status", async () => {
    app = makeTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/docs/static/swagger-ui.css",
      headers: { range: "bytes=999999999-" },
    });

    expect(response.statusCode).toBe(416);
    expect(response.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(response.json()).toMatchObject({ status: 416, code: "request_error" });
  });

  it("keeps the status of an http-errors client error but not its message", async () => {
    app = makeTestApp();
    app.get("/test/exposed", async () => {
      throw Object.assign(new Error("upstream rejected key sk-123"), {
        statusCode: 401,
        expose: true,
      });
    });

    const response = await app.inject({ method: "GET", url: "/test/exposed" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      code: "request_error",
    });
  });

  it("keeps the status of a pre-routing framework error other than a bad URL", async () => {
    app = makeTestApp();
    app.get("/test/items/:id", async () => ({ ok: true }));

    const response = await app.inject({ method: "GET", url: `/test/items/${"x".repeat(150)}` });

    expect(response.statusCode).toBe(414);
    expect(response.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(response.json()).toMatchObject({ status: 414, code: "request_error" });
  });

  it("answers an undecodable URL with a 400 problem carrying the request id", async () => {
    app = makeTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/%E0%A4%A",
      headers: { "x-request-id": "req-bad-url" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(response.headers["x-request-id"]).toBe("req-bad-url");
    expect(response.json()).toMatchObject({ status: 400, code: "validation_error" });
  });

  it("carries the request id on error responses", async () => {
    app = makeTestApp();
    app.get("/test/boom", async () => {
      throw new Error("boom");
    });

    const notFound = await app.inject({
      method: "GET",
      url: "/nope",
      headers: { "x-request-id": "req-404" },
    });
    const failed = await app.inject({
      method: "GET",
      url: "/test/boom",
      headers: { "x-request-id": "req-500" },
    });

    expect(notFound.headers["x-request-id"]).toBe("req-404");
    expect(failed.headers["x-request-id"]).toBe("req-500");
  });
});

describe("request body limit", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  const url = "/sessions/0190a8f0-7c3e-7a1b-8c2d-3e4f5a6b7c8d/messages";

  it("answers a body above 128 KiB with 413 before parsing it", async () => {
    app = makeTestApp();

    const response = await app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ content: "x".repeat(131_072) }),
    });

    expect(response.statusCode).toBe(413);
    expect(response.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(response.json()).toMatchObject({ status: 413, code: "request_error" });
  });

  it("still parses the largest send, 16,000 characters each sent as a six-byte JSON escape", async () => {
    app = makeTestApp();
    // An invalid provider makes validation answer, without touching the database.
    const payload = `{"content":"${"\\u0001".repeat(16_000)}","provider":1}`;
    expect(payload.length).toBeGreaterThan(96_000);

    const response = await app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "validation_error" });
  });
});
