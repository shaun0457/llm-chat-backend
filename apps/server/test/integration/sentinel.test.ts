import type { FastifyInstance, InjectOptions } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { Db } from "../../src/db/client.js";
import { useTestDatabase } from "../helpers/db.js";
import { makeHostedTestApp } from "../helpers/hosted.js";
import { type LogCapture, captureLogs } from "../helpers/log-capture.js";
import { type Message, createSession } from "../helpers/messages.js";
import {
  type Responder,
  errorOf,
  rawStream,
  streamOf,
  useUpstream,
} from "../helpers/msw-openai.js";

/** Obviously fake, and in no format the scrubber recognises: only its literal removal helps. */
const SENTINEL = "sentinel-byok-7d1e2f90";

const testDb = useTestDatabase();
const upstream = useUpstream();

/**
 * Every row of every table outside the system schemas, as its complete text representation
 * (all columns, whatever their type). Fails when discovery finds nothing to scan.
 */
async function everyRow(db: Db): Promise<{ tables: string[]; rows: string[] }> {
  const { rows: tables } = await db.pool.query<{ schema: string; name: string }>(
    `SELECT table_schema AS schema, table_name AS name
       FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('pg_catalog', 'information_schema')
        AND table_schema NOT LIKE 'pg\\_%'`,
  );
  const rows: string[] = [];
  for (const { schema, name } of tables) {
    const quoted = `"${schema.replaceAll('"', '""')}"."${name.replaceAll('"', '""')}"`;
    const result = await db.pool.query<{ row: string }>(`SELECT t::text AS row FROM ${quoted} t`);
    rows.push(...result.rows.map(({ row }) => row));
  }
  return { tables: tables.map(({ schema, name }) => `${schema}.${name}`), rows };
}

describe("the sentinel key appears nowhere", () => {
  let app: FastifyInstance;
  let logs: LogCapture;
  /** Status line, headers and body of every response the test saw. */
  const responses: string[] = [];

  async function call(
    options: InjectOptions,
  ): Promise<{ statusCode: number; json: () => unknown }> {
    const response = await app.inject(options);
    responses.push(`${response.statusCode} ${JSON.stringify(response.headers)} ${response.body}`);
    return response;
  }

  /** Sends one message with the sentinel key, then reads everything the API offers about it. */
  async function sendAndReadBack(responder: Responder): Promise<Message> {
    logs = captureLogs();
    app = makeHostedTestApp({ db: testDb.db, env: { LOG_LEVEL: "trace" }, logStream: logs.stream });
    upstream.reply(responder);
    const session = await createSession(app, { provider: "nvidia" });

    const sent = await call({
      method: "POST",
      url: `/sessions/${session.id}/messages`,
      payload: { content: "Tell me something" },
      headers: { "x-llm-api-key": SENTINEL },
    });
    const { assistantMessage } = sent.json() as { assistantMessage: Message };
    await call({ method: "GET", url: `/sessions/${session.id}/messages/${assistantMessage.id}` });
    await call({ method: "GET", url: `/sessions/${session.id}/messages` });
    await call({ method: "GET", url: `/sessions/${session.id}` });
    await call({ method: "GET", url: "/sessions" });
    return assistantMessage;
  }

  async function expectNoSentinel(): Promise<void> {
    // The upstream really received it: the scan is not vacuous.
    expect(
      upstream.requests.some((request) => request.authorization === `Bearer ${SENTINEL}`),
    ).toBe(true);
    expect(logs.lines().length).toBeGreaterThan(0);
    expect(logs.lines().filter((line) => line.includes(SENTINEL))).toEqual([]);

    expect(responses.length).toBeGreaterThan(0);
    expect(responses.filter((response) => response.includes(SENTINEL))).toEqual([]);

    const { tables, rows } = await everyRow(testDb.db);
    expect(tables).toEqual(expect.arrayContaining(["public.sessions", "public.messages"]));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.includes(SENTINEL))).toEqual([]);
  }

  afterEach(async () => {
    responses.length = 0;
    await app.close();
  });

  it("on success", async () => {
    const answer = await sendAndReadBack(
      streamOf([{ content: "Something." }, { finishReason: "stop" }]),
    );

    expect(answer.status).toBe("completed");
    await expectNoSentinel();
  });

  it("on an upstream 401 whose body echoes the key", async () => {
    const answer = await sendAndReadBack(
      errorOf(401, {
        error: {
          message: `Incorrect API key provided: ${SENTINEL}. Header was: Bearer ${SENTINEL}`,
          code: "invalid_api_key",
        },
      }),
    );

    expect(answer).toMatchObject({ status: "failed", errorCode: "llm_auth_failed" });
    expect(answer.errorDetail).toBe(
      "The model provider answered HTTP 401: Incorrect API key provided: [REDACTED]. " +
        "Header was: Bearer [REDACTED]",
    );
    await expectNoSentinel();
  });

  it("on a persistent upstream 500 whose body echoes the key", async () => {
    const answer = await sendAndReadBack(
      errorOf(500, { message: `internal error for key=${SENTINEL} (${SENTINEL})` }),
    );

    expect(answer).toMatchObject({ status: "failed", errorCode: "llm_upstream_error" });
    expect(answer.errorDetail).toContain("[REDACTED]");
    expect(upstream.requests).toHaveLength(3);
    await expectNoSentinel();
  });

  it("on an error event inside the stream that echoes the key", async () => {
    const answer = await sendAndReadBack(
      rawStream(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "par" } }] })}\n\n` +
          `data: ${JSON.stringify({ error: { message: `stream broke for ${SENTINEL}` } })}\n\n`,
      ),
    );

    expect(answer).toMatchObject({ status: "failed", errorCode: "llm_upstream_error" });
    await expectNoSentinel();
  });
});
