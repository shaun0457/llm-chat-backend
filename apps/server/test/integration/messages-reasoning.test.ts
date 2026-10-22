import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { useTestDatabase } from "../helpers/db.js";
import { makeHostedTestApp } from "../helpers/hosted.js";
import { type LogCapture, captureLogs } from "../helpers/log-capture.js";
import { type Message, createSession } from "../helpers/messages.js";
import {
  type ChunkSpec,
  REASONING_FIELDS,
  type ReasoningField,
  streamOf,
  useUpstream,
} from "../helpers/msw-openai.js";
import { everyRow } from "../helpers/rows.js";
import { closeListeningApp, eventsOf, listen, parseSse } from "../helpers/sse-client.js";

/** Marks every reasoning chunk, so that any trace of reasoning can be searched for. */
const MARKER = "reasoning-marker-5c0e";
const KEY = "byok-key-not-real-0036";
const ANSWER = "Paris is the capital.";

const testDb = useTestDatabase();
const upstream = useUpstream();

type Turn = { userMessage: Message; assistantMessage: Message };

/** Reasoning first, then the answer; one chunk carries both, as some servers send. */
function reasoningThenAnswer(reasoningField: ReasoningField): ChunkSpec[] {
  return [
    { reasoningField, reasoning: `${MARKER} the user asks about France. ` },
    { reasoningField, reasoning: `${MARKER} its capital is Paris.`, content: "" },
    { content: "Paris is " },
    { reasoningField, reasoning: `${MARKER} late`, content: "the capital." },
    { finishReason: "stop" },
    { noChoices: true, usage: { prompt_tokens: 15, completion_tokens: 42 } },
  ];
}

/** Reasoning until the output budget runs out: no answer text at all. */
function reasoningOnly(reasoningField: ReasoningField): ChunkSpec[] {
  return [
    { reasoningField, reasoning: `${MARKER} thinking ` },
    { reasoningField, reasoning: `${MARKER} still thinking`, content: "" },
    { finishReason: "length", usage: { prompt_tokens: 15, completion_tokens: 4096 } },
  ];
}

describe.each(REASONING_FIELDS)("reasoning in %s is filtered out (#36)", (reasoningField) => {
  let app: FastifyInstance;
  let logs: LogCapture;
  /** Status, headers and body of every response the test saw. */
  const responses: string[] = [];

  async function start(): Promise<string> {
    logs = captureLogs();
    app = makeHostedTestApp({ db: testDb.db, env: { LOG_LEVEL: "trace" }, logStream: logs.stream });
    return listen(app);
  }

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(url, init);
    const body = await response.clone().text();
    responses.push(
      `${response.status} ${JSON.stringify(Object.fromEntries(response.headers))} ${body}`,
    );
    return response;
  }

  function sendJson(base: string, sessionId: string, content: string): Promise<Response> {
    return request(`${base}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-llm-api-key": KEY },
      body: JSON.stringify({ content }),
    });
  }

  async function sendSse(base: string, sessionId: string, content: string): Promise<string> {
    const response = await request(`${base}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: {
        "accept": "text/event-stream",
        "content-type": "application/json",
        "x-llm-api-key": KEY,
      },
      body: JSON.stringify({ content }),
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    return response.text();
  }

  /** Reads back everything the API offers about the turn, so the scan covers it too. */
  async function readBack(base: string, sessionId: string, messageId: string): Promise<Message> {
    const message = await request(`${base}/sessions/${sessionId}/messages/${messageId}`);
    await request(`${base}/sessions/${sessionId}/messages/${messageId}/events`);
    await request(`${base}/sessions/${sessionId}/messages`);
    await request(`${base}/sessions/${sessionId}`);
    return (await message.json()) as Message;
  }

  /** No log line, response or database row holds any reasoning; none of the scans is empty. */
  async function expectNoReasoningAnywhere(): Promise<void> {
    expect(upstream.requests.length).toBeGreaterThan(0);
    expect(logs.lines().length).toBeGreaterThan(0);
    expect(logs.lines().filter((line) => line.includes(MARKER))).toEqual([]);
    expect(responses.length).toBeGreaterThan(0);
    expect(responses.filter((response) => response.includes(MARKER))).toEqual([]);
    const { tables, rows } = await everyRow(testDb.db);
    expect(tables).toEqual(expect.arrayContaining(["public.sessions", "public.messages"]));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.includes(MARKER))).toEqual([]);
  }

  afterEach(async () => {
    responses.length = 0;
    await closeListeningApp(app);
  });

  it("a JSON send stores and returns only the answer, with usage and finish reason; the next turn's history holds only the answer", async () => {
    const base = await start();
    upstream.reply(
      streamOf(reasoningThenAnswer(reasoningField)),
      streamOf([{ content: "Its name is Paris." }, { finishReason: "stop" }]),
    );
    const session = await createSession(app, { provider: "nvidia" });

    const response = await sendJson(base, session.id, "What is the capital of France?");

    expect(response.status).toBe(200);
    const { assistantMessage } = (await response.json()) as Turn;
    const expected = {
      status: "completed",
      content: ANSWER,
      usage: { promptTokens: 15, completionTokens: 42 },
      finishReason: "stop",
      errorCode: null,
    };
    expect(assistantMessage).toMatchObject(expected);
    expect(await readBack(base, session.id, assistantMessage.id)).toMatchObject(expected);

    const next = await sendJson(base, session.id, "Say its name again.");

    expect(next.status).toBe(200);
    expect(upstream.requests[1]?.body.messages).toEqual([
      { role: "user", content: "What is the capital of France?" },
      { role: "assistant", content: ANSWER },
      { role: "user", content: "Say its name again." },
    ]);
    await expectNoReasoningAnywhere();
  });

  it("an event stream carries only answer text in its deltas, and done holds only the answer", async () => {
    const base = await start();
    upstream.reply(streamOf(reasoningThenAnswer(reasoningField)));
    const session = await createSession(app, { provider: "nvidia" });

    const body = await sendSse(base, session.id, "What is the capital of France?");

    const events = eventsOf(parseSse(body));
    expect(events[0]?.event).toBe("message.created");
    expect(events.at(-1)?.event).toBe("done");
    const created = events[0]?.data as Turn;
    const deltas = events
      .filter(({ event }) => event === "delta")
      .map(({ data }) => (data as { text: string }).text);
    // The snapshot may already hold the start of the answer; together they are the answer.
    expect(created.assistantMessage.content + deltas.join("")).toBe(ANSWER);
    const { assistantMessage } = events.at(-1)?.data as { assistantMessage: Message };
    expect(assistantMessage).toMatchObject({
      status: "completed",
      content: ANSWER,
      usage: { promptTokens: 15, completionTokens: 42 },
      finishReason: "stop",
    });
    await readBack(base, session.id, assistantMessage.id);
    await expectNoReasoningAnywhere();
  });

  it("a JSON send whose output budget ends in reasoning fails with llm_upstream_error and no content", async () => {
    const base = await start();
    upstream.reply(streamOf(reasoningOnly(reasoningField)));
    const session = await createSession(app, { provider: "nvidia" });

    const response = await sendJson(base, session.id, "What is the capital of France?");

    expect(response.status).toBe(502);
    const failed = {
      status: "failed",
      content: "",
      errorCode: "llm_upstream_error",
      errorDetail: "The model used its whole output budget before it started the answer.",
    };
    const problem = (await response.json()) as { code: string; assistantMessage: Message };
    expect(problem).toMatchObject({ code: "llm_upstream_error", assistantMessage: failed });
    expect(await readBack(base, session.id, problem.assistantMessage.id)).toMatchObject(failed);
    await expectNoReasoningAnywhere();
  });

  it("an event stream whose output budget ends in reasoning sends no delta and ends with error", async () => {
    const base = await start();
    upstream.reply(streamOf(reasoningOnly(reasoningField)));
    const session = await createSession(app, { provider: "nvidia" });

    const body = await sendSse(base, session.id, "What is the capital of France?");

    const events = eventsOf(parseSse(body));
    expect(events.map(({ event }) => event)).toEqual(["message.created", "error"]);
    expect(events[1]?.data).toMatchObject({
      code: "llm_upstream_error",
      assistantMessage: { status: "failed", content: "", errorCode: "llm_upstream_error" },
    });
    await expectNoReasoningAnywhere();
  });
});
