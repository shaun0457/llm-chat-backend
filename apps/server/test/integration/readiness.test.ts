import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/db/migrate.js";
import { MIGRATIONS_FOLDER } from "../../src/paths.js";
import { makeTestApp } from "../helpers/app.js";
import { type TestDatabase, createTestDatabase, useTestDatabase } from "../helpers/db.js";

const PROBLEM_JSON = /^application\/problem\+json/;

describe("GET /health/ready", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const ready = (target: FastifyInstance) => target.inject({ method: "GET", url: "/health/ready" });

  describe("on a fully migrated database", () => {
    const testDb = useTestDatabase("all");

    it("answers 200 ready", async () => {
      app = makeTestApp({ db: testDb.db });

      const response = await ready(app);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ready" });
    });
  });

  describe("on a database one migration short", () => {
    const testDb = useTestDatabase("all-but-last");

    it("answers 503 not_ready with migrations_pending", async () => {
      app = makeTestApp({ db: testDb.db });

      const response = await ready(app);

      expect(response.statusCode).toBe(503);
      expect(response.headers["content-type"]).toMatch(PROBLEM_JSON);
      expect(response.json()).toEqual({
        type: "about:blank",
        title: "Service Unavailable",
        status: 503,
        code: "not_ready",
        detail: "migrations_pending",
      });
    });
  });

  describe("on a database that has applied a migration this build does not know", () => {
    const testDb = useTestDatabase("all");

    it("answers 503 not_ready with migrations_pending", async () => {
      await testDb.db.drizzle.execute(
        sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('future', 99999999999999)`,
      );
      app = makeTestApp({ db: testDb.db });

      const response = await ready(app);

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "not_ready", detail: "migrations_pending" });
    });
  });

  describe("when the database stops answering", () => {
    const testDb = useTestDatabase("all");

    it("answers 503 database_unreachable within a few seconds instead of hanging", async () => {
      // An open transaction holding an exclusive lock makes the migrations query wait forever.
      const blocker = await testDb.db.pool.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query('LOCK TABLE drizzle."__drizzle_migrations" IN ACCESS EXCLUSIVE MODE');
        app = makeTestApp({ db: testDb.db });

        const started = Date.now();
        const response = await ready(app);

        expect(Date.now() - started).toBeLessThan(5_000);
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({
          code: "not_ready",
          detail: "database_unreachable",
        });
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
    }, 15_000);
  });

  describe("on an empty database", () => {
    const testDb = useTestDatabase("none");

    it("answers 503 migrations_pending, then 200 once migrated: nothing is cached", async () => {
      app = makeTestApp({ db: testDb.db });

      const before = await ready(app);
      await runMigrations(testDb.url, MIGRATIONS_FOLDER);
      const after = await ready(app);

      expect(before.statusCode).toBe(503);
      expect(before.json()).toMatchObject({ detail: "migrations_pending" });
      expect(after.statusCode).toBe(200);
    });
  });

  describe("when the database cannot be reached", () => {
    let closed: TestDatabase;

    beforeAll(async () => {
      closed = await createTestDatabase();
      await closed.db.close();
    });
    afterAll(async () => {
      await closed.drop();
    });

    it("answers 503 database_unreachable for a stopped pool", async () => {
      app = makeTestApp({ db: closed.db });

      const response = await ready(app);

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "not_ready", detail: "database_unreachable" });
    });

    it("answers 503 database_unreachable when nothing listens, while /health stays 200", async () => {
      app = makeTestApp();

      const response = await ready(app);
      const live = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ detail: "database_unreachable" });
      expect(live.statusCode).toBe(200);
    });
  });
});
