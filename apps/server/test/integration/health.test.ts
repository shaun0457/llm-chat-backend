import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { makeTestApp } from "../helpers/app.js";

describe("GET /health", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("reports the process as alive", async () => {
    app = makeTestApp();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.json()).toEqual({ status: "ok" });
  });
});
