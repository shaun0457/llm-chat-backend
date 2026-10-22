import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { TEST_ENV, makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { createSession } from "../helpers/messages.js";

const testDb = useTestDatabase();

describe("rate limits", () => {
  let app: FastifyInstance;

  function start(env: Record<string, string>): void {
    app = makeTestApp({ db: testDb.db, config: loadConfig({ ...TEST_ENV, ...env }) });
  }

  afterEach(async () => {
    await app.close();
  });

  function get(
    url: string,
    from: string,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    return app.inject({ method: "GET", url, remoteAddress: from, headers });
  }

  function sendFrom(
    from: string,
    sessionId: string,
    payload: Record<string, unknown> = { content: "Hi" },
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/messages`,
      remoteAddress: from,
      payload,
    });
  }

  function expectRateLimited(response: LightMyRequestResponse): void {
    expect(response.statusCode).toBe(429);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({ status: 429, code: "rate_limited" });
    const retryAfter = Number(response.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  }

  /** Spends `count` requests of the general budget of `from`, each answered normally. */
  async function spend(count: number, from: string, headers: Record<string, string> = {}) {
    for (let request = 0; request < count; request += 1) {
      expect((await get("/providers", from, headers)).statusCode).toBe(200);
    }
  }

  describe("rate-limit.general", () => {
    it("answers the request after the limit with 429 rate_limited and Retry-After", async () => {
      start({ RATE_LIMIT_GENERAL_PER_MIN: "5" });
      await spend(5, "198.51.100.1");

      expectRateLimited(await get("/providers", "198.51.100.1"));
      // Unknown routes count against the same budget.
      expectRateLimited(await get("/nowhere", "198.51.100.1"));
    });

    it("never limits the health checks", async () => {
      start({ RATE_LIMIT_GENERAL_PER_MIN: "2" });
      await spend(2, "198.51.100.2");

      for (let request = 0; request < 5; request += 1) {
        expect((await get("/health", "198.51.100.2")).statusCode).toBe(200);
        expect((await get("/health/ready", "198.51.100.2")).statusCode).toBe(200);
      }
      expectRateLimited(await get("/providers", "198.51.100.2"));
    });

    it("keeps a separate budget per client address", async () => {
      start({ RATE_LIMIT_GENERAL_PER_MIN: "3" });
      await spend(3, "198.51.100.3");
      expectRateLimited(await get("/providers", "198.51.100.3"));

      expect((await get("/providers", "198.51.100.4")).statusCode).toBe(200);
    });

    it("ignores X-Forwarded-For without TRUST_PROXY", async () => {
      start({ RATE_LIMIT_GENERAL_PER_MIN: "3" });
      for (const forwarded of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
        await spend(1, "198.51.100.5", { "x-forwarded-for": forwarded });
      }

      expectRateLimited(
        await get("/providers", "198.51.100.5", { "x-forwarded-for": "203.0.113.4" }),
      );
    });

    describe("with TRUST_PROXY=10.0.0.1", () => {
      it("keys a request from the trusted proxy by the address it forwarded, not the leftmost value", async () => {
        start({ RATE_LIMIT_GENERAL_PER_MIN: "3", TRUST_PROXY: "10.0.0.1" });
        await spend(3, "10.0.0.1", { "x-forwarded-for": "1.1.1.1, 2.2.2.2" });

        // Only the leftmost (client-supplied) value changed: still 2.2.2.2's budget.
        expectRateLimited(
          await get("/providers", "10.0.0.1", { "x-forwarded-for": "9.9.9.9, 2.2.2.2" }),
        );
        // Another address forwarded by the proxy has its own budget.
        expect(
          (await get("/providers", "10.0.0.1", { "x-forwarded-for": "1.1.1.1, 3.3.3.3" }))
            .statusCode,
        ).toBe(200);
      });

      it("ignores the forwarding header of an untrusted socket and keys it by the socket", async () => {
        start({ RATE_LIMIT_GENERAL_PER_MIN: "3", TRUST_PROXY: "10.0.0.1" });
        for (const forwarded of ["1.1.1.1, 2.2.2.2", "1.1.1.1, 3.3.3.3", "1.1.1.1, 4.4.4.4"]) {
          await spend(1, "10.0.0.2", { "x-forwarded-for": forwarded });
        }

        expectRateLimited(
          await get("/providers", "10.0.0.2", { "x-forwarded-for": "1.1.1.1, 5.5.5.5" }),
        );
        // The forwarded address itself was never charged.
        expect(
          (await get("/providers", "10.0.0.1", { "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))
            .statusCode,
        ).toBe(200);
      });
    });
  });

  describe("rate-limit.send", () => {
    it("answers a send over the send limit with 429 while the general budget still has room", async () => {
      start({ RATE_LIMIT_GENERAL_PER_MIN: "100", RATE_LIMIT_SEND_PER_MIN: "3" });
      const session = await createSession(app);
      for (let turn = 1; turn <= 3; turn += 1) {
        expect((await sendFrom("198.51.100.10", session.id)).statusCode).toBe(200);
      }

      expectRateLimited(await sendFrom("198.51.100.10", session.id));
      expect((await get(`/sessions/${session.id}`, "198.51.100.10")).statusCode).toBe(200);
      expect((await sendFrom("198.51.100.11", session.id)).statusCode).toBe(200);
    });

    it("counts a repeated send (a replay) like any other send", async () => {
      start({ RATE_LIMIT_GENERAL_PER_MIN: "100", RATE_LIMIT_SEND_PER_MIN: "3" });
      const session = await createSession(app);
      const turn = { id: "0190a8f0-7c3e-7a1b-8c2d-3e4f5a6b7c8d", content: "Same again" };
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect((await sendFrom("198.51.100.12", session.id, turn)).statusCode).toBe(200);
      }

      expectRateLimited(await sendFrom("198.51.100.12", session.id, turn));
    });

    it("applies the general budget to sends too: both limits hold at once", async () => {
      start({ RATE_LIMIT_GENERAL_PER_MIN: "5", RATE_LIMIT_SEND_PER_MIN: "20" });
      const session = await createSession(app);
      for (let request = 0; request < 4; request += 1) {
        expect((await get(`/sessions/${session.id}`, "198.51.100.13")).statusCode).toBe(200);
      }

      expect((await sendFrom("198.51.100.13", session.id)).statusCode).toBe(200);
      expectRateLimited(await sendFrom("198.51.100.13", session.id));
    });
  });
});
