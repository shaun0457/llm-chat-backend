import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { makeTestApp } from "../helpers/app.js";
import { type LogCapture, captureLogs } from "../helpers/log-capture.js";

const SENTINEL = "sk-sentinel-4f1c9a7e";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("logging", () => {
  let app: FastifyInstance;
  let logs: LogCapture;

  function makeLoggingApp(): FastifyInstance {
    logs = captureLogs();
    return makeTestApp({
      config: loadConfig({ NODE_ENV: "test", LOG_LEVEL: "trace" }),
      logStream: logs.stream,
    });
  }

  afterEach(async () => {
    await app.close();
  });

  describe("credential redaction", () => {
    const secretHeaders = { "x-llm-api-key": SENTINEL, "authorization": `Bearer ${SENTINEL}` };

    // Regression guard: Fastify's default request serializer logs no headers today.
    it("default request logging never writes the API key or bearer token", async () => {
      app = makeLoggingApp();

      await app.inject({ method: "GET", url: "/health", headers: secretHeaders });

      expect(logs.lines().length).toBeGreaterThan(0);
      expect(logs.lines().filter((line) => line.includes(SENTINEL))).toEqual([]);
    });

    it("redacts the headers even when a handler logs them explicitly", async () => {
      app = makeLoggingApp();
      app.get("/test/log-headers", async (request) => {
        request.log.info({ headers: request.headers }, "headers");
        request.log.info({ req: { headers: request.headers } }, "nested headers");
        return { ok: true };
      });

      await app.inject({ method: "GET", url: "/test/log-headers", headers: secretHeaders });

      expect(logs.lines().some((line) => line.includes("[REDACTED]"))).toBe(true);
      expect(logs.lines().filter((line) => line.includes(SENTINEL))).toEqual([]);
    });

    it("default error logging never writes the secrets", async () => {
      app = makeLoggingApp();
      app.get("/test/boom", async () => {
        throw new Error("boom");
      });

      await app.inject({ method: "GET", url: "/test/boom", headers: secretHeaders });

      expect(logs.lines().filter((line) => line.includes(SENTINEL))).toEqual([]);
    });
  });

  describe("request id", () => {
    it("echoes a valid incoming x-request-id and logs with it", async () => {
      app = makeLoggingApp();

      const response = await app.inject({
        method: "GET",
        url: "/health",
        headers: { "x-request-id": "client-req-42" },
      });

      expect(response.headers["x-request-id"]).toBe("client-req-42");
      expect(logs.entries().some((entry) => entry.reqId === "client-req-42")).toBe(true);
    });

    it("generates a UUID when none is sent and uses it in the request's log lines", async () => {
      app = makeLoggingApp();

      const response = await app.inject({ method: "GET", url: "/health" });

      const id = response.headers["x-request-id"];
      expect(id).toMatch(UUID);
      expect(logs.entries().some((entry) => entry.reqId === id)).toBe(true);
    });

    it.each([
      ["too long", "a".repeat(129)],
      ["containing spaces", "has spaces"],
      ["containing non-ASCII", "id-é"],
    ])("replaces an id %s with a generated UUID", async (_label, invalid) => {
      app = makeLoggingApp();

      const response = await app.inject({
        method: "GET",
        url: "/health",
        headers: { "x-request-id": invalid },
      });

      expect(response.headers["x-request-id"]).toMatch(UUID);
    });

    it("logs an unexpected error together with the request id", async () => {
      app = makeLoggingApp();
      app.get("/test/boom", async () => {
        throw new Error("boom");
      });

      const response = await app.inject({ method: "GET", url: "/test/boom" });

      const id = response.headers["x-request-id"];
      const errorEntries = logs.entries().filter((entry) => entry.level === 50);
      expect(errorEntries).toEqual([
        expect.objectContaining({ reqId: id, err: expect.objectContaining({ message: "boom" }) }),
      ]);
    });
  });
});
