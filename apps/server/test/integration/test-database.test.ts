import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { sessions } from "../../src/db/schema.js";
import { useTestDatabase } from "../helpers/db.js";

const testDb = useTestDatabase();

// test-database-isolation.test.ts runs the same check in parallel against its own database.
describe("per-file test database", () => {
  it("is migrated and keeps the rows this file writes", async () => {
    const id = "01900000-0000-7000-8000-00000000000a";
    await testDb.db.drizzle.insert(sessions).values({
      id,
      provider: "demo",
      model: "demo",
      lastActivityAt: new Date(),
    });

    const rows = await testDb.db.drizzle.select().from(sessions).where(eq(sessions.id, id));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, title: null, nextSeq: 1 });
  });

  it("contains no rows written by other test files", async () => {
    const rows = await testDb.db.drizzle.select({ id: sessions.id }).from(sessions);

    expect(rows.map((row) => row.id)).toEqual(["01900000-0000-7000-8000-00000000000a"]);
  });
});
