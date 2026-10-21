import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db/client.js";
import { TEST_ENV, makeTestApp, testJobs } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider, createGate } from "../helpers/fake-llm.js";
import {
  type Message,
  allMessages,
  createSession,
  eventually,
  getMessage,
  send,
} from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";

const testDb = useTestDatabase();

/** Older than the default stale threshold (180 + 10 + 50 = 240 s). */
const STALE_SECONDS = 300;
/** Well within it. */
const YOUNG_SECONDS = 10;

/**
 * A turn left behind by a process that crashed: a user message and a generating assistant
 * message whose attempt started `ageSeconds` ago on the database clock, with no job behind it.
 */
async function insertCrashedTurn(
  db: Db,
  sessionId: string,
  ageSeconds: number,
): Promise<{ userId: string; assistantId: string }> {
  const userId = randomUUID();
  const assistantId = randomUUID();
  const { rowCount } = await db.pool.query(
    `WITH s AS (
       UPDATE sessions SET next_seq = next_seq + 2 WHERE id = $1 RETURNING next_seq - 2 AS seq
     )
     INSERT INTO messages (id, session_id, seq, role, reply_to_id, content, status, attempt,
                           started_at, provider, model)
     SELECT $2::uuid, $1::uuid, s.seq, 'user', NULL::uuid, 'Hi', 'completed', 1,
            NULL::timestamptz, NULL, NULL FROM s
     UNION ALL
     SELECT $3::uuid, $1::uuid, s.seq + 1, 'assistant', $2::uuid, 'Half an answer', 'generating',
            1, clock_timestamp() - $4::int * interval '1 second', 'demo', 'demo' FROM s`,
    [sessionId, userId, assistantId, ageSeconds],
  );
  expect(rowCount).toBe(2);
  return { userId, assistantId };
}

/** Moves a running attempt's start back in time, as if it had been running that long. */
async function age(db: Db, assistantId: string, seconds: number): Promise<void> {
  await db.pool.query(
    "UPDATE messages SET started_at = started_at - $2 * interval '1 second' WHERE id = $1",
    [assistantId, seconds],
  );
}

describe("stale reclaim", () => {
  let app: FastifyInstance;
  /**
   * Reads through the API without reclaiming anything: its threshold (one hour of deadline
   * alone) is far above every row's age here, so what it shows is what is stored.
   */
  let observer: FastifyInstance;

  beforeAll(() => {
    observer = makeTestApp({
      db: testDb.db,
      config: loadConfig({ ...TEST_ENV, GENERATION_DEADLINE_MS: "3600000" }),
    });
    return () => observer.close();
  });

  afterEach(async () => {
    await app.close();
  });

  const stored = async (sessionId: string, id: string): Promise<Message> => {
    const response = await getMessage(observer, sessionId, id);
    expect(response.statusCode).toBe(200);
    return response.json();
  };

  describe("reclaim.crash", () => {
    it("fails a crashed turn as interrupted on read, keeps its partial text, and admits a new send", async () => {
      app = makeTestApp({ db: testDb.db });
      const session = await createSession(app);
      const { assistantId } = await insertCrashedTurn(testDb.db, session.id, STALE_SECONDS);

      const response = await getMessage(app, session.id, assistantId);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: "failed",
        errorCode: "interrupted",
        errorDetail: "The generation was interrupted.",
        content: "Half an answer",
        attempt: 1,
      });
      const next = await send(app, session.id, { content: "Are you there?" });
      expect(next.statusCode).toBe(200);
      expect(next.json().assistantMessage).toMatchObject({ status: "completed" });
    });

    const touches: Array<
      [string, (app: FastifyInstance, sessionId: string) => Promise<LightMyRequestResponse>]
    > = [
      ["GET /sessions/:id", (app, id) => app.inject({ method: "GET", url: `/sessions/${id}` })],
      [
        "GET /sessions/:id/messages",
        (app, id) => app.inject({ method: "GET", url: `/sessions/${id}/messages` }),
      ],
      [
        "PATCH /sessions/:id",
        (app, id) =>
          app.inject({ method: "PATCH", url: `/sessions/${id}`, payload: { title: "Renamed" } }),
      ],
      ["POST /sessions/:id/messages", (app, id) => send(app, id, { content: "Next" })],
    ];

    it.each(touches)("%s reclaims the session's stale turn", async (_route, touch) => {
      app = makeTestApp({ db: testDb.db });
      const session = await createSession(app);
      const { assistantId } = await insertCrashedTurn(testDb.db, session.id, STALE_SECONDS);
      expect((await stored(session.id, assistantId)).status).toBe("generating");

      const response = await touch(app, session.id);

      expect(response.statusCode).toBeLessThan(300);
      expect(await stored(session.id, assistantId)).toMatchObject({
        status: "failed",
        errorCode: "interrupted",
      });
    });

    it("leaves other sessions' stale turns alone", async () => {
      app = makeTestApp({ db: testDb.db });
      const session = await createSession(app);
      const other = await createSession(app);
      const { assistantId } = await insertCrashedTurn(testDb.db, other.id, STALE_SECONDS);

      await app.inject({ method: "GET", url: `/sessions/${session.id}` });

      expect((await stored(other.id, assistantId)).status).toBe("generating");
    });
  });

  describe("reclaim.young", () => {
    it.each([
      [
        "GET …/:mid",
        (app: FastifyInstance, sessionId: string, id: string) => getMessage(app, sessionId, id),
      ],
      [
        "a new send",
        (app: FastifyInstance, sessionId: string) => send(app, sessionId, { content: "Next" }),
      ],
    ])("%s leaves a turn younger than the threshold generating", async (_route, touch) => {
      app = makeTestApp({ db: testDb.db });
      const session = await createSession(app);
      const { assistantId } = await insertCrashedTurn(testDb.db, session.id, YOUNG_SECONDS);

      await touch(app, session.id, assistantId);

      expect(await stored(session.id, assistantId)).toMatchObject({
        status: "generating",
        errorCode: null,
        content: "Half an answer",
      });
      // Still the session's active turn.
      expect((await send(app, session.id, { content: "Next" })).statusCode).toBe(409);
    });
  });

  describe("reclaim.fenced", () => {
    it.each([
      [
        "a read",
        (app: FastifyInstance, sessionId: string, id: string) => getMessage(app, sessionId, id),
      ],
      [
        "a PATCH",
        (app: FastifyInstance, sessionId: string) =>
          app.inject({ method: "PATCH", url: `/sessions/${sessionId}`, payload: { title: "x" } }),
      ],
    ])(
      "a worker that resumes after %s reclaimed its row writes nothing more and stops",
      async (_route, touch) => {
        const fake = new FakeLlmProvider();
        const gate = createGate();
        fake.script({ deltas: ["Hel", "lo"], gate: gate.promise, gateAfter: 1, hang: true });
        const jobs = testJobs(testDb.db);
        app = makeTestApp({ db: testDb.db, jobs, ...testProviders({ llm: fake }) });
        const session = await createSession(app);
        const pending = send(app, session.id, { content: "Hi" }, { prefer: "respond-async" });
        const [, assistant] = await eventually(
          () => allMessages(observer, session.id),
          (messages) => messages[1]?.content === "Hel",
        );
        const job = jobs.get(assistant?.id ?? "");
        if (assistant === undefined || job === undefined) {
          throw new Error("expected the generation to be running");
        }
        expect((await pending).statusCode).toBe(202);

        // The worker is frozen at the gate past the stale threshold; the touch reclaims it.
        await age(testDb.db, assistant.id, STALE_SECONDS);
        await touch(app, session.id, assistant.id);
        const reclaimed = await stored(session.id, assistant.id);
        expect(reclaimed).toMatchObject({ status: "failed", errorCode: "interrupted" });
        gate.release();

        // Its next flush ("Hello") matches no row: the job stops without a terminal write.
        expect(await job.finished).toBe("aborted");
        expect(fake.signals[0]?.aborted).toBe(true);
        expect(await stored(session.id, assistant.id)).toEqual(reclaimed);
      },
    );
  });
});
