import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { TEST_ENV, makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { createSession } from "../helpers/messages.js";
import { closeListeningApp, listen, openSse } from "../helpers/sse-client.js";

/** Headers every response carries, whatever its route and status. */
function expectSecurityHeaders(response: LightMyRequestResponse): void {
  const csp = String(response.headers["content-security-policy"]);
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("frame-ancestors 'self'");
  expect(csp).toContain("object-src 'none'");
  // The API is also served over plain HTTP (locally, in compose): never upgrade its assets.
  expect(csp).not.toContain("upgrade-insecure-requests");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
  expect(response.headers["strict-transport-security"]).toContain("max-age=");
  expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
}

const EXPOSED = ["location", "retry-after", "preference-applied", "x-request-id"];

describe("security headers", () => {
  let app: FastifyInstance;

  function start(env: Record<string, string> = {}): void {
    app = makeTestApp({ config: loadConfig({ ...TEST_ENV, ...env }) });
  }

  afterEach(async () => {
    await app.close();
  });

  describe("helmet", () => {
    it("sets them on JSON responses, problem details and rate-limited answers", async () => {
      start({ RATE_LIMIT_GENERAL_PER_MIN: "1" });

      const ok = await app.inject({ method: "GET", url: "/providers" });
      const limited = await app.inject({ method: "GET", url: "/providers" });
      const health = await app.inject({ method: "GET", url: "/health" });
      const invalid = await app.inject({
        method: "GET",
        url: "/sessions/123",
        remoteAddress: "198.51.100.20",
      });

      expect(ok.statusCode).toBe(200);
      expect(limited.statusCode).toBe(429);
      expect(invalid.statusCode).toBe(400);
      for (const response of [ok, limited, health, invalid]) {
        expectSecurityHeaders(response);
      }
    });

    it("keeps /docs working: its page loads only same-origin scripts and styles the policy allows", async () => {
      start();

      const page = await app.inject({ method: "GET", url: "/docs/" });

      expect(page.statusCode).toBe(200);
      expectSecurityHeaders(page);
      const html = page.body;
      const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1] ?? "");
      expect(assets.length).toBeGreaterThan(0);
      // Relative URLs only (no CDN) and no inline script, which script-src 'self' would block.
      for (const asset of assets) {
        expect(asset).toMatch(/^\.\//);
      }
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
      for (const asset of assets) {
        const response = await app.inject({ method: "GET", url: `/docs/${asset.slice(2)}` });
        expect(response.statusCode, asset).toBe(200);
      }
      const initializer = await app.inject({
        method: "GET",
        url: "/docs/static/swagger-initializer.js",
      });
      expect(initializer.headers["content-type"]).toContain("javascript");
      // The document it renders is same-origin (connect-src falls back to 'self').
      expect(initializer.body).toContain("json");
    });
  });

  describe("cors", () => {
    it("sends no CORS headers without CORS_ORIGINS", async () => {
      start();

      const response = await app.inject({
        method: "GET",
        url: "/providers",
        headers: { origin: "https://a.example" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("allows a listed origin, exposes the API's headers and ignores other origins", async () => {
      start({ CORS_ORIGINS: "https://a.example" });

      const allowed = await app.inject({
        method: "GET",
        url: "/providers",
        headers: { origin: "https://a.example" },
      });
      const other = await app.inject({
        method: "GET",
        url: "/providers",
        headers: { origin: "https://b.example" },
      });

      expect(allowed.headers["access-control-allow-origin"]).toBe("https://a.example");
      expect(String(allowed.headers.vary)).toContain("Origin");
      const exposed = String(allowed.headers["access-control-expose-headers"])
        .toLowerCase()
        .split(/\s*,\s*/);
      expect(exposed).toEqual(expect.arrayContaining(EXPOSED));
      expect(allowed.headers["access-control-allow-credentials"]).toBeUndefined();
      expect(other.statusCode).toBe(200);
      expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("answers a preflight from a listed origin for a send with its headers", async () => {
      start({ CORS_ORIGINS: "https://a.example" });
      const preflight = (origin: string) =>
        app.inject({
          method: "OPTIONS",
          url: "/sessions/0190a8f0-7c3e-7a1b-8c2d-3e4f5a6b7c8d/messages",
          headers: {
            "origin": origin,
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type, prefer, x-llm-api-key",
          },
        });

      const allowed = await preflight("https://a.example");
      const other = await preflight("https://b.example");

      expect(allowed.statusCode).toBe(204);
      expect(allowed.headers["access-control-allow-origin"]).toBe("https://a.example");
      expect(String(allowed.headers["access-control-allow-methods"])).toContain("POST");
      const allowedHeaders = String(allowed.headers["access-control-allow-headers"])
        .toLowerCase()
        .split(/\s*,\s*/);
      expect(allowedHeaders).toEqual(
        expect.arrayContaining(["content-type", "prefer", "x-llm-api-key"]),
      );
      expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("allows any origin with CORS_ORIGINS=*", async () => {
      start({ CORS_ORIGINS: "*" });

      const response = await app.inject({
        method: "GET",
        url: "/providers",
        headers: { origin: "https://anywhere.example" },
      });

      expect(response.headers["access-control-allow-origin"]).toBe("*");
    });

    it("lets a browser read a 429's Retry-After", async () => {
      start({ CORS_ORIGINS: "https://a.example", RATE_LIMIT_GENERAL_PER_MIN: "1" });
      const request = () =>
        app.inject({ method: "GET", url: "/providers", headers: { origin: "https://a.example" } });

      await request();
      const limited = await request();

      expect(limited.statusCode).toBe(429);
      expect(limited.headers["access-control-allow-origin"]).toBe("https://a.example");
      expect(String(limited.headers["access-control-expose-headers"]).toLowerCase()).toContain(
        "retry-after",
      );
    });
  });
});

describe("security headers on event streams (socket)", () => {
  const testDb = useTestDatabase();
  let app: FastifyInstance;

  afterEach(async () => {
    await closeListeningApp(app);
  });

  it("carries the helmet and CORS headers on a hijacked SSE response", async () => {
    app = makeTestApp({
      db: testDb.db,
      config: loadConfig({ ...TEST_ENV, CORS_ORIGINS: "https://a.example" }),
    });
    const base = await listen(app);
    const session = await createSession(app);

    const stream = await openSse(`${base}/sessions/${session.id}/messages`, {
      method: "POST",
      headers: {
        "accept": "text/event-stream",
        "content-type": "application/json",
        "origin": "https://a.example",
      },
      body: JSON.stringify({ content: "Hi" }),
    });
    const { error } = await stream.drain();

    expect(error).toBeUndefined();
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(stream.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(stream.headers.get("x-content-type-options")).toBe("nosniff");
    expect(stream.headers.get("strict-transport-security")).toContain("max-age=");
    expect(stream.headers.get("access-control-allow-origin")).toBe("https://a.example");
    const exposed = (stream.headers.get("access-control-expose-headers") ?? "")
      .toLowerCase()
      .split(/\s*,\s*/);
    expect(exposed).toEqual(expect.arrayContaining(EXPOSED));
  });
});
