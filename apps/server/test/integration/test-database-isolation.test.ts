import { describe, expect, it } from "vitest";

import { sessions } from "../../src/db/schema.js";
import { useTestDatabase } from "../helpers/db.js";

const testDb = useTestDatabase();

// Counterpart of test-database.test.ts: each file sees only its own row.
describe("per-file test database isolation", () => {
  it("contains only the row this file wrote", async () => {
    const id = "01900000-0000-7000-8000-00000000000b";
    await testDb.db.drizzle.insert(sessions).values({
      id,
      provider: "demo",
      model: "demo",
      lastActivityAt: new Date(),
    });

    const rows = await testDb.db.drizzle.select({ id: sessions.id }).from(sessions);

    expect(rows.map((row) => row.id)).toEqual([id]);
  });
});
