import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { makeTestApp } from "../helpers/app.js";

describe("API documentation", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("still serves the document when a route has no schema at all", async () => {
    app = makeTestApp();
    // In a plugin, so that it is registered after swagger's onRoute hook, like the app's routes.
    void app.register(async (child) => {
      child.get("/test/no-schema", async () => ({ ok: true }));
    });

    const response = await app.inject({ method: "GET", url: "/openapi.json" });

    expect(response.statusCode).toBe(200);
    expect(response.json().paths["/test/no-schema"]).toBeDefined();
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

  it("documents the message routes, the 502 failure shape and the null attempt of users", async () => {
    app = makeTestApp();

    const { paths } = (await app.inject({ method: "GET", url: "/openapi.json" })).json();

    expect(Object.keys(paths["/sessions/{id}/messages"]).sort()).toEqual(["get", "post"]);
    expect(Object.keys(paths["/sessions/{id}/messages/{mid}"])).toEqual(["get"]);
    const send = paths["/sessions/{id}/messages"].post;
    expect(Object.keys(send.responses).sort()).toEqual(["200", "202", "502"]);
    const failed = send.responses["502"].content["application/problem+json"].schema;
    expect(failed.required).toEqual(
      expect.arrayContaining(["code", "detail", "userMessage", "assistantMessage"]),
    );
    const message =
      paths["/sessions/{id}/messages/{mid}"].get.responses["200"].content["application/json"]
        .schema;
    expect(message.properties.attempt.anyOf).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "null" })]),
    );
    expect(message.properties).not.toHaveProperty("systemPrompt");
  });

  it("states the provider-only rule for PATCH /sessions/:id and for a send", async () => {
    app = makeTestApp();

    const { paths } = (await app.inject({ method: "GET", url: "/openapi.json" })).json();

    const patch = paths["/sessions/{id}"].patch.requestBody.content["application/json"].schema;
    expect(patch.properties.provider.description).toBe(
      "Alone: that provider's default model, including when it is already the current " +
        "provider; omit provider to preserve the current model",
    );
    const send =
      paths["/sessions/{id}/messages"].post.requestBody.content["application/json"].schema;
    expect(Object.keys(send.properties).sort()).toEqual(["content", "id", "model", "provider"]);
    expect(send.properties.provider.description).toContain(
      "Alone: that provider's default model, including when it is the session's provider",
    );
    const sendDescription: string = paths["/sessions/{id}/messages"].post.description;
    for (const code of [
      "input_too_long",
      "provider_busy",
      "server_busy",
      "Retry-After: 10",
      "message_id_conflict",
      "429 rate_limited",
    ]) {
      expect(sendDescription).toContain(code);
    }
    expect(sendDescription).toContain("provider/model for this turn only");
  });

  it("states the rate limits, the 429 problem and the missing authentication in the document's description", async () => {
    app = makeTestApp();

    const { info } = (await app.inject({ method: "GET", url: "/openapi.json" })).json();

    for (const text of [
      "No authentication",
      "429",
      "rate_limited",
      "Retry-After",
      "RATE_LIMIT_GENERAL_PER_MIN",
      "RATE_LIMIT_SEND_PER_MIN",
      "/health",
    ]) {
      expect(info.description).toContain(text);
    }
  });

  it("documents a send's id as a UUID in any case, except the nil and max UUID", async () => {
    app = makeTestApp();

    const { paths } = (await app.inject({ method: "GET", url: "/openapi.json" })).json();

    const id: { format?: string; pattern?: string; allOf?: Array<{ pattern?: string }> } =
      paths["/sessions/{id}/messages"].post.requestBody.content["application/json"].schema
        .properties.id;
    expect(id.format).toBe("uuid");
    // JSON Schema patterns are ECMA-262 regular expressions, matched without anchoring.
    const patterns = [id.pattern, ...(id.allOf ?? []).map((part) => part.pattern)]
      .filter((pattern): pattern is string => pattern !== undefined)
      .map((pattern) => new RegExp(pattern, "u"));
    expect(patterns.length).toBeGreaterThan(0);
    const allowed = (value: string): boolean => patterns.every((pattern) => pattern.test(value));
    expect(allowed("6f1c2b9e-3d4a-4c5b-9e8f-0a1b2c3d4e5f")).toBe(true);
    expect(allowed("6F1C2B9E-3D4A-4C5B-9E8F-0A1B2C3D4E5F")).toBe(true);
    expect(allowed("00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(allowed("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(false);
    expect(allowed("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF")).toBe(false);
  });

  it("documents Prefer, the three send outcomes and their headers, and the uncached poll target", async () => {
    app = makeTestApp();

    const { paths } = (await app.inject({ method: "GET", url: "/openapi.json" })).json();

    const send = paths["/sessions/{id}/messages"].post;
    const prefer = send.parameters.find(
      (parameter: { in: string; name: string }) =>
        parameter.in === "header" && parameter.name === "prefer",
    );
    expect(prefer).toMatchObject({ required: false, schema: { type: "string" } });
    expect(prefer.description).toContain("respond-async");
    expect(prefer.description).toContain("wait=");

    const headersOf = (status: string): string[] =>
      Object.keys(send.responses[status].headers ?? {}).sort();
    expect(headersOf("200")).toEqual(["Preference-Applied", "Vary"]);
    expect(headersOf("202")).toEqual([
      "Cache-Control",
      "Location",
      "Preference-Applied",
      "Retry-After",
      "Vary",
    ]);
    expect(headersOf("502")).toEqual(["Preference-Applied", "Vary"]);
    expect(send.responses["200"].headers.Vary.schema).toMatchObject({ enum: ["Accept"] });
    for (const status of ["200", "202"]) {
      expect(send.responses[status].content["application/json"].schema.required).toEqual(
        expect.arrayContaining(["userMessage", "assistantMessage"]),
      );
    }
    expect(send.responses["202"].description).toMatch(/still being generated/i);
    expect(send.responses["202"].headers.Location.description).toMatch(/poll/i);

    const poll = paths["/sessions/{id}/messages/{mid}"].get;
    expect(Object.keys(poll.responses["200"].headers ?? {})).toEqual(["Cache-Control"]);
  });

  it("serves the interactive docs as HTML", async () => {
    app = makeTestApp();

    const response = await app.inject({ method: "GET", url: "/docs" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/html/);
  });
});
