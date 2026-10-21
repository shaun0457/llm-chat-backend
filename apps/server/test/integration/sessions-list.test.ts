import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";

type Page = { items: Array<{ id: string; lastActivityAt: string }>; nextCursor: string | null };

async function collectPages(app: FastifyInstance, limit: number): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor === null ? `limit=${limit}` : `limit=${limit}&cursor=${cursor}`;
    const response = await app.inject({ method: "GET", url: `/sessions?${query}` });
    expect(response.statusCode).toBe(200);
    const page = response.json() as Page;
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== null && pages.length < 100);
  return pages;
}

describe("GET /sessions", () => {
  describe("with 45 sessions", () => {
    const testDb = useTestDatabase();
    let app: FastifyInstance;
    let created: string[];

    beforeAll(async () => {
      const setup = makeTestApp({ db: testDb.db });
      created = [];
      for (let i = 0; i < 45; i += 1) {
        const response = await setup.inject({ method: "POST", url: "/sessions" });
        created.push(response.json().id as string);
      }
      await setup.close();
    });
    beforeEach(() => {
      app = makeTestApp({ db: testDb.db });
    });
    afterEach(async () => {
      await app.close();
    });

    it("pages 20/20/5 through every session once, newest activity first", async () => {
      const pages = await collectPages(app, 20);

      expect(pages.map((page) => page.items.length)).toEqual([20, 20, 5]);
      expect(pages.at(-1)?.nextCursor).toBeNull();
      const ids = pages.flatMap((page) => page.items.map((item) => item.id));
      expect(new Set(ids).size).toBe(45);
      // Created one after another, so the newest activity is the last one created.
      expect(ids).toEqual([...created].reverse());
    });

    it("returns 20 items by default", async () => {
      const response = await app.inject({ method: "GET", url: "/sessions" });

      expect(response.json().items).toHaveLength(20);
      expect(response.json().nextCursor).toEqual(expect.any(String));
    });

    it("returns every session on one page with limit=100 and no next cursor", async () => {
      const response = await app.inject({ method: "GET", url: "/sessions?limit=100" });

      expect(response.json().items).toHaveLength(45);
      expect(response.json().nextCursor).toBeNull();
    });

    it.each([
      ["limit=0", "querystring.limit"],
      ["limit=101", "querystring.limit"],
      ["limit=abc", "querystring.limit"],
      ["limit=1.5", "querystring.limit"],
      ["cursor=not-a-cursor", "querystring.cursor"],
      [`cursor=${Buffer.from('{"t":"x","id":"y"}').toString("base64url")}`, "querystring.cursor"],
    ])("rejects %s with 400 validation_error", async (query, field) => {
      const response = await app.inject({ method: "GET", url: `/sessions?${query}` });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "validation_error" });
      expect(response.json().detail).toContain(field);
    });
  });

  describe("with activity times less than a millisecond apart", () => {
    const testDb = useTestDatabase();

    // There is no API to set activity times, so these rows are fixtures written directly.
    // Expected order: activity desc, then id desc for the two rows with the same time.
    const expectedOrder = [
      "01900000-0000-7000-8000-000000000005", // .000400
      "01900000-0000-7000-8000-000000000004", // .000300
      "01900000-0000-7000-8000-000000000006", // .000200 (tie, higher id)
      "01900000-0000-7000-8000-000000000003", // .000200 (tie, lower id)
      "01900000-0000-7000-8000-000000000002", // .000100
      "01900000-0000-7000-8000-000000000001", // .000000
    ];

    beforeAll(async () => {
      await testDb.db.drizzle.execute(sql`
        INSERT INTO sessions (id, provider, model, last_activity_at) VALUES
          ('01900000-0000-7000-8000-000000000001', 'demo', 'demo', '2026-01-01T00:00:00.000000Z'),
          ('01900000-0000-7000-8000-000000000002', 'demo', 'demo', '2026-01-01T00:00:00.000100Z'),
          ('01900000-0000-7000-8000-000000000003', 'demo', 'demo', '2026-01-01T00:00:00.000200Z'),
          ('01900000-0000-7000-8000-000000000006', 'demo', 'demo', '2026-01-01T00:00:00.000200Z'),
          ('01900000-0000-7000-8000-000000000004', 'demo', 'demo', '2026-01-01T00:00:00.000300Z'),
          ('01900000-0000-7000-8000-000000000005', 'demo', 'demo', '2026-01-01T00:00:00.000400Z')
      `);
    });

    it("pages with limit=1 without skipping or repeating any session", async () => {
      const app = makeTestApp({ db: testDb.db });

      const pages = await collectPages(app, 1);

      expect(pages.flatMap((page) => page.items.map((item) => item.id))).toEqual(expectedOrder);
      expect(pages.at(-1)?.nextCursor).toBeNull();
      await app.close();
    });

    it("reports activity times at microsecond precision", async () => {
      const app = makeTestApp({ db: testDb.db });

      const response = await app.inject({ method: "GET", url: "/sessions?limit=1" });

      expect(response.json().items[0].lastActivityAt).toBe("2026-01-01T00:00:00.000400Z");
      await app.close();
    });
  });
});
