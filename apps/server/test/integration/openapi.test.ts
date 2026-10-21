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
    expect(
      document.paths["/health"].get.responses["200"].content["application/json"].schema,
    ).toEqual(
      expect.objectContaining({
        type: "object",
        required: ["status"],
        properties: { status: { type: "string", enum: ["ok"] } },
      }),
    );
  });

  it("documents the session, provider and readiness routes from their schemas", async () => {
    app = makeTestApp();

    const { paths } = (await app.inject({ method: "GET", url: "/openapi.json" })).json();

    expect(Object.keys(paths["/sessions"]).sort()).toEqual(["get", "post"]);
    expect(Object.keys(paths["/sessions/{id}"]).sort()).toEqual(["delete", "get", "patch"]);
    expect(paths["/providers"].get).toBeDefined();
    expect(paths["/health/ready"].get).toBeDefined();
    expect(
      paths["/sessions"].get.parameters.map((parameter: { name: string }) => parameter.name),
    ).toEqual(expect.arrayContaining(["limit", "cursor"]));
    const session = paths["/sessions/{id}"].get.responses["200"].content["application/json"].schema;
    expect(session.properties.createdAt.description).toContain(
      "ISO-8601 UTC with microsecond precision",
    );
    expect(session.properties.lastActivityAt.description).toContain(
      "ISO-8601 UTC with microsecond precision",
    );
  });

  it("serves the interactive docs as HTML", async () => {
    app = makeTestApp();

    const response = await app.inject({ method: "GET", url: "/docs" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/html/);
  });
});
