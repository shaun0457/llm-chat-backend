import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { makeTestApp } from "../helpers/app.js";

describe("API documentation", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("serves an OpenAPI 3 document generated from the route schemas", async () => {
    app = makeTestApp();

    const response = await app.inject({ method: "GET", url: "/openapi.json" });

    expect(response.statusCode).toBe(200);
    const document = response.json();
    expect(document.openapi).toMatch(/^3\./);
    expect(document.paths["/health"].get.responses["200"].content["application/json"].schema).toEqual(
      expect.objectContaining({
        type: "object",
        required: ["status"],
        properties: { status: { type: "string", enum: ["ok"] } },
      }),
    );
  });

  it("serves the interactive docs as HTML", async () => {
    app = makeTestApp();

    const response = await app.inject({ method: "GET", url: "/docs" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/html/);
  });
});
