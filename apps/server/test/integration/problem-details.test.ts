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
});
