import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { sendMessageHeaders } from "../../src/modules/messages/schemas.js";
import { TEST_ENV, makeTestApp } from "../helpers/app.js";
import { type LogCapture, captureLogs } from "../helpers/log-capture.js";

const SENTINEL = "sk-sentinel-4f1c9a7e";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("logging", () => {
  let app: FastifyInstance;
  let logs: LogCapture;

  function makeLoggingApp(): FastifyInstance {
    logs = captureLogs();
    return makeTestApp({
      config: loadConfig({ ...TEST_ENV, LOG_LEVEL: "trace" }),
      logStream: logs.stream,
    });
  }

  afterEach(async () => {
    await app.close();
  });

  describe("credential redaction", () => {
    const secretHeaders = {
      "x-llm-api-key": SENTINEL,
      "authorization": `Bearer ${SENTINEL}`,
      "proxy-authorization": `Basic ${SENTINEL}`,
      "cookie": `session=${SENTINEL}`,
    };

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

    it("still redacts them after a route's header schema (the send route's Prefer) has run", async () => {
      app = makeLoggingApp();
      app.get(
        "/test/log-validated-headers",
        { schema: { headers: sendMessageHeaders } },
        async (request) => {
          request.log.info({ headers: request.headers }, "validated headers");
          return { kept: Object.keys(request.headers).sort() };
        },
      );

      const response = await app.inject({
        method: "GET",
        url: "/test/log-validated-headers",
        headers: { ...secretHeaders, prefer: "respond-async" },
      });

      // Fastify merges the validated headers over the raw ones: every header is still there.
      expect(response.json().kept).toEqual(
        expect.arrayContaining(["authorization", "cookie", "prefer", "x-llm-api-key"]),
      );
      const logged = logs.entries().find((entry) => entry.msg === "validated headers");
      expect(logged?.headers).toMatchObject({
        "x-llm-api-key": "[REDACTED]",
        "authorization": "[REDACTED]",
        "prefer": "respond-async",
      });
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

    it("redacts apiKey fields wherever a log line carries them", async () => {
      app = makeLoggingApp();
      app.get("/test/log-key", async (request) => {
        request.log.info({ apiKey: SENTINEL, job: { apiKey: SENTINEL } }, "with keys");
        return { ok: true };
      });

      await app.inject({ method: "GET", url: "/test/log-key" });

      const logged = logs.entries().find((entry) => entry.msg === "with keys");
      expect(logged).toMatchObject({ apiKey: "[REDACTED]", job: { apiKey: "[REDACTED]" } });
      expect(logs.lines().filter((line) => line.includes(SENTINEL))).toEqual([]);
    });
  });

  describe("error serializer", () => {
    function throwing(error: unknown): FastifyInstance {
      app = makeLoggingApp();
      app.get("/test/throw", async () => {
        throw error;
      });
      return app;
    }

    // The serializer cannot know the key; SENTINEL has the sk- format the scrubber recognises.
    it("logs only allowlisted fields of an SDK-style error, scrubbing its message", async () => {
      const error = Object.assign(new Error(`401 key ${SENTINEL} rejected`), {
        status: 401,
        code: "invalid_api_key",
        headers: { authorization: `Bearer ${SENTINEL}` },
        config: { headers: { "Authorization": `Bearer ${SENTINEL}`, "x-api-key": SENTINEL } },
        request: { headers: { authorization: `Bearer ${SENTINEL}` }, body: SENTINEL },
        error: { message: SENTINEL },
      });
      await throwing(error).inject({ method: "GET", url: "/test/throw" });

      const entry = logs.entries().find((candidate) => candidate.msg === "unhandled error");
      expect(entry?.err).toEqual({
        type: "Error",
        message: expect.stringContaining("401 key"),
        stack: expect.any(String),
        status: 401,
        code: "invalid_api_key",
      });
      expect(logs.lines().filter((line) => line.includes(SENTINEL))).toEqual([]);
    });

    it("removes bearer tokens from messages along the cause chain", async () => {
      const error = new Error("outer", {
        cause: new Error(`upstream said Authorization: Bearer ${SENTINEL}`, {
          cause: Object.assign(new Error("innermost"), { config: { apiKey: SENTINEL } }),
        }),
      });
      await throwing(error).inject({ method: "GET", url: "/test/throw" });

      const entry = logs.entries().find((candidate) => candidate.msg === "unhandled error");
      expect(entry?.err).toMatchObject({
        message: "outer",
        cause: {
          message: "upstream said Authorization: Bearer [REDACTED]",
          cause: { message: "innermost" },
        },
      });
      expect(logs.lines().filter((line) => line.includes(SENTINEL))).toEqual([]);
    });

    it("never logs the parameters of a failed database query", async () => {
      // What drizzle throws for a failed query: its message and `params` carry the values.
      const pgError = Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
        constraint: "messages_pkey",
        table: "messages",
        detail: `Key (id)=(${SENTINEL}) already exists.`,
        where: SENTINEL,
      });
      const queryError = Object.assign(
        new Error(`Failed query: insert into "messages" values ($1)\nparams: ${SENTINEL}`, {
          cause: pgError,
        }),
        { query: 'insert into "messages" values ($1)', params: [SENTINEL] },
      );
      await throwing(queryError).inject({ method: "GET", url: "/test/throw" });

      const entry = logs.entries().find((candidate) => candidate.msg === "unhandled error");
      expect(entry?.err).toMatchObject({
        message: 'Failed query: insert into "messages" values ($1)\nparams: [omitted]',
        cause: { code: "23505", constraint: "messages_pkey", table: "messages" },
      });
      expect(logs.lines().filter((line) => line.includes(SENTINEL))).toEqual([]);
    });

    it("survives a cause chain that loops back on itself", async () => {
      const error = new Error("loop");
      (error as Error & { cause: unknown }).cause = error;

      const response = await throwing(error).inject({ method: "GET", url: "/test/throw" });

      expect(response.statusCode).toBe(500);
      const entry = logs.entries().find((candidate) => candidate.msg === "unhandled error");
      expect(entry?.err).toMatchObject({ message: "loop" });
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
