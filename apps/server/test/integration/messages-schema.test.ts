import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";

import { pgConstraint, pgErrorCode } from "../../src/db/errors.js";
import { messages, sessions } from "../../src/db/schema.js";
import { useTestDatabase } from "../helpers/db.js";

const testDb = useTestDatabase();

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

async function newSession(): Promise<string> {
  const id = uuidv7();
  await testDb.db.drizzle.insert(sessions).values({
    id,
    provider: "demo",
    model: "demo",
    lastActivityAt: sql`clock_timestamp()`,
  });
  return id;
}

type Status = "generating" | "completed" | "failed";

async function insertTurn(sessionId: string, seq: number, status: Status): Promise<void> {
  const userId = uuidv7();
  await testDb.db.drizzle.insert(messages).values([
    { id: userId, sessionId, seq, role: "user", content: "hi", status: "completed" },
    {
      id: uuidv7(),
      sessionId,
      seq: seq + 1,
      role: "assistant",
      replyToId: userId,
      status,
      startedAt: sql`clock_timestamp()`,
      provider: "demo",
      model: "demo",
    },
  ]);
}

const caught = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("messages table constraints", () => {
  it("lets a completed and a generating assistant coexist in one session", async () => {
    const sessionId = await newSession();

    await insertTurn(sessionId, 1, "completed");
    await insertTurn(sessionId, 3, "generating");

    const { rows } = await testDb.db.pool.query(
      "SELECT count(*)::int AS n FROM messages WHERE session_id = $1",
      [sessionId],
    );
    expect(rows[0].n).toBe(4);
  });

  it("rejects a second generating assistant in one session, naming the partial index (V2)", async () => {
    const sessionId = await newSession();
    await insertTurn(sessionId, 1, "generating");

    const error = await caught(insertTurn(sessionId, 3, "generating"));

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    expect(pgConstraint(error)).toBe("messages_one_generating_per_session");
  });

  it("allows generating assistants in different sessions at the same time", async () => {
    await insertTurn(await newSession(), 1, "generating");

    await expect(insertTurn(await newSession(), 1, "generating")).resolves.toBeUndefined();
  });

  it("rejects a duplicate seq in one session", async () => {
    const sessionId = await newSession();
    await insertTurn(sessionId, 1, "completed");

    const error = await caught(insertTurn(sessionId, 2, "completed"));

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    expect(pgConstraint(error)).toBe("messages_session_id_seq_unique");
  });

  it.each([
    ["a user row that is not completed", { status: "failed" }],
    ["a user row with a provider", { provider: "demo" }],
    ["a user row replying to something", { replyToId: "self" }],
    ["a user row with an error code", { errorCode: "llm_upstream_error" }],
  ])("rejects %s", async (_name, change) => {
    const sessionId = await newSession();
    const id = uuidv7();
    const values = {
      id,
      sessionId,
      seq: 1,
      role: "user" as const,
      content: "hi",
      status: "completed" as Status,
      ...change,
      ...("replyToId" in change ? { replyToId: id } : {}),
    } as typeof messages.$inferInsert;

    const error = await caught(testDb.db.drizzle.insert(messages).values(values));

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it("rejects an assistant row without the turn it replies to or its frozen settings", async () => {
    const sessionId = await newSession();

    const error = await caught(
      testDb.db.drizzle.insert(messages).values({
        id: uuidv7(),
        sessionId,
        seq: 1,
        role: "assistant",
        status: "generating",
        startedAt: sql`clock_timestamp()`,
      }),
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it("deletes a session's messages with the session", async () => {
    const sessionId = await newSession();
    await insertTurn(sessionId, 1, "completed");

    await testDb.db.pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);

    const { rows } = await testDb.db.pool.query(
      "SELECT count(*)::int AS n FROM messages WHERE session_id = $1",
      [sessionId],
    );
    expect(rows[0].n).toBe(0);
  });
});
