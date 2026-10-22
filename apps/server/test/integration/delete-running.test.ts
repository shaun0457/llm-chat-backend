import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { TEST_ENV, makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider } from "../helpers/fake-llm.js";
import { type LogCapture, captureLogs } from "../helpers/log-capture.js";
import { type Message, createSession, eventually, getMessage, send } from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";
import { closeListeningApp, listen, openSse } from "../helpers/sse-client.js";

const testDb = useTestDatabase();

type TurnBody = { userMessage: Message; assistantMessage: Message };

/** Log levels of pino: 50 is error, 60 fatal. */
const ERROR_LEVEL = 50;

describe("delete.running", () => {
  let app: FastifyInstance;
  let fake: FakeLlmProvider;
  let logs: LogCapture;
  let listening = false;

  function start(env: Record<string, string> = {}): void {
    fake = new FakeLlmProvider("fake", { hang: true });
    logs = captureLogs();
    listening = false;
    app = makeTestApp({
      db: testDb.db,
      config: loadConfig({ ...TEST_ENV, LOG_LEVEL: "info", ...env }),
      logStream: logs.stream,
      ...testProviders({ llm: fake }),
    });
  }

  afterEach(async () => {
    await (listening ? closeListeningApp(app) : app.close());
  });

  /** Admits a turn whose generation never finishes on its own; returns once the model runs. */
  async function hangingTurn(sessionId: string): Promise<TurnBody> {
    const calls = fake.requests.length;
    const response = await send(
      app,
      sessionId,
      { content: "Keep going" },
      { prefer: "respond-async" },
    );
    expect(response.statusCode).toBe(202);
    await eventually(
      async () => fake.requests.length,
      (length) => length > calls,
    );
    return response.json();
  }

  it("aborts the running generation, removes every row and frees its capacity slot", async () => {
    start({ MAX_ACTIVE_GENERATIONS: "1" });
    const doomed = await createSession(app);
    const turn = await hangingTurn(doomed.id);
    const other = await createSession(app);
    const full = await send(app, other.id, { content: "Hi" });
    expect(full.json()).toMatchObject({ code: "server_busy" });

    const deleted = await app.inject({ method: "DELETE", url: `/sessions/${doomed.id}` });

    expect(deleted.statusCode).toBe(204);
    // Aborted by the delete itself: no flush, deadline or later request was needed.
    expect(fake.signals[0]?.aborted).toBe(true);
    for (const message of [turn.userMessage, turn.assistantMessage]) {
      expect((await getMessage(app, doomed.id, message.id)).statusCode).toBe(404);
    }
    const rows = await testDb.db.drizzle.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM messages WHERE session_id = ${doomed.id}`,
    );
    expect(rows.rows[0]?.count).toBe(0);
    // The slot is free as soon as the delete has answered: the full limit admits again.
    fake.script({ deltas: ["Fine"] });
    const admitted = await send(app, other.id, { content: "Hi" });
    expect(admitted.statusCode).toBe(200);
    expect(logs.entries().filter((entry) => Number(entry.level) >= ERROR_LEVEL)).toEqual([]);
  });

  it("aborts the local job of a stale generating row, after reclaim failed the row", async () => {
    start();
    const session = await createSession(app);
    const turn = await hangingTurn(session.id);
    // The row looks dead to stale reclaim, while its job still runs in this process.
    await testDb.db.drizzle.execute(
      sql`UPDATE messages SET started_at = clock_timestamp() - interval '1 day'
          WHERE id = ${turn.assistantMessage.id}`,
    );

    const deleted = await app.inject({ method: "DELETE", url: `/sessions/${session.id}` });

    expect(deleted.statusCode).toBe(204);
    const signal = fake.signals[0];
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toMatchObject({ stop: "deleted" });
    expect(logs.entries().filter((entry) => Number(entry.level) >= ERROR_LEVEL)).toEqual([]);
  });

  it("ends an open event stream of the deleted turn promptly, without a final event", async () => {
    start();
    const base = await listen(app);
    listening = true;
    const session = await createSession(app);
    const stream = await openSse(`${base}/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "accept": "text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ content: "Stream it" }),
    });
    const created = await stream.nextEvent();
    expect(created?.event).toBe("message.created");
    const { assistantMessage } = created?.data as TurnBody;

    const startedAt = Date.now();
    const deleted = await app.inject({ method: "DELETE", url: `/sessions/${session.id}` });
    const { frames, error } = await stream.drain();

    expect(deleted.statusCode).toBe(204);
    expect(error).toBeUndefined();
    // Deltas written before the delete may still arrive; no final event follows them.
    const names = frames.flatMap((frame) => (frame.kind === "event" ? [frame.event] : []));
    expect(names.filter((name) => name !== "delta")).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const again = await app.inject({
      method: "GET",
      url: `/sessions/${session.id}/messages/${assistantMessage.id}/events`,
    });
    expect(again.statusCode).toBe(404);
  });

  it("answers a JSON send waiting for the deleted turn with 404 session_not_found", async () => {
    start();
    const session = await createSession(app);
    const calls = fake.requests.length;
    const waiting = send(app, session.id, { content: "Wait for me" }, { prefer: "wait=30" });
    await eventually(
      async () => fake.requests.length,
      (length) => length > calls,
    );

    const deleted = await app.inject({ method: "DELETE", url: `/sessions/${session.id}` });
    const response = await waiting;

    expect(deleted.statusCode).toBe(204);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "session_not_found" });
  });
});
