import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { useTestDatabase } from "../helpers/db.js";
import { makeHostedTestApp } from "../helpers/hosted.js";
import { captureLogs } from "../helpers/log-capture.js";
import { type Message, createSession, getMessage, send } from "../helpers/messages.js";
import { errorOf, streamOf, useUpstream } from "../helpers/msw-openai.js";

const testDb = useTestDatabase();
const upstream = useUpstream();
const KEY = "byok-key-not-real-0042";

type Turn = { userMessage: Message; assistantMessage: Message };

describe("hosted provider (nvidia) end to end", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("lists nvidia with requiresKey true and its catalogued models", async () => {
    app = makeHostedTestApp({ db: testDb.db });

    const response = await app.inject({ method: "GET", url: "/providers" });

    expect(response.statusCode).toBe(200);
    const nvidia = (
      response.json() as { providers: Array<{ id: string; requiresKey: boolean }> }
    ).providers.find((provider) => provider.id === "nvidia");
    expect(nvidia).toEqual({
      id: "nvidia",
      requiresKey: true,
      defaultModel: "nvidia/nemotron-3-ultra-550b-a55b",
      models: [
        { id: "nvidia/nemotron-3-ultra-550b-a55b", contextWindow: 262144, maxOutputTokens: 4096 },
      ],
    });
  });

  it("answers 200 with the completed answer and stores its usage, using the header key", async () => {
    app = makeHostedTestApp({ db: testDb.db });
    upstream.reply(
      streamOf([
        { content: "Hello" },
        { content: " there" },
        { finishReason: "stop" },
        { noChoices: true, usage: { prompt_tokens: 21, completion_tokens: 3 } },
      ]),
    );
    const session = await createSession(app, { provider: "nvidia" });

    const response = await send(app, session.id, { content: "Hi" }, { "x-llm-api-key": KEY });

    expect(response.statusCode).toBe(200);
    const { assistantMessage }: Turn = response.json();
    expect(assistantMessage).toMatchObject({
      status: "completed",
      content: "Hello there",
      provider: "nvidia",
      model: "nvidia/nemotron-3-ultra-550b-a55b",
      usage: { promptTokens: 21, completionTokens: 3 },
      finishReason: "stop",
    });
    const stored = await getMessage(app, session.id, assistantMessage.id);
    expect(stored.json()).toMatchObject({ usage: { promptTokens: 21, completionTokens: 3 } });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.authorization).toBe(`Bearer ${KEY}`);
    expect(upstream.requests[0]?.body).toMatchObject({
      model: "nvidia/nemotron-3-ultra-550b-a55b",
      max_tokens: 4096,
      messages: [{ role: "user", content: "Hi" }],
    });
  });

  it("uses the operator key when no header is sent", async () => {
    app = makeHostedTestApp({ db: testDb.db, operatorKeys: { nvidia: "operator-key-not-real" } });
    upstream.reply(streamOf([{ content: "ok", finishReason: "stop" }]));
    const session = await createSession(app, { provider: "nvidia" });

    const response = await send(app, session.id, { content: "Hi" });

    expect(response.statusCode).toBe(200);
    expect(upstream.requests[0]?.authorization).toBe("Bearer operator-key-not-real");
  });

  it("rejects a send without any key with 422 before calling upstream", async () => {
    app = makeHostedTestApp({ db: testDb.db });
    const session = await createSession(app, { provider: "nvidia" });

    const response = await send(app, session.id, { content: "Hi" });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "llm_credential_missing" });
    expect(upstream.requests).toHaveLength(0);
  });

  it("answers 502 llm_auth_failed after one upstream request when the key is rejected", async () => {
    app = makeHostedTestApp({ db: testDb.db });
    upstream.reply(errorOf(401, { status: 401, title: "Unauthorized", detail: "Invalid JWT" }));
    const session = await createSession(app, { provider: "nvidia" });

    const response = await send(app, session.id, { content: "Hi" }, { "x-llm-api-key": KEY });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      code: "llm_auth_failed",
      detail: "The model provider answered HTTP 401: Invalid JWT",
      assistantMessage: {
        status: "failed",
        errorCode: "llm_auth_failed",
        errorDetail: "The model provider answered HTTP 401: Invalid JWT",
      },
    });
    expect(upstream.requests).toHaveLength(1);
  });

  it("fails with llm_upstream_error and keeps the partial text when the stream ends without a finish reason", async () => {
    app = makeHostedTestApp({ db: testDb.db });
    upstream.reply(streamOf([{ content: "half an " }, { content: "answer" }]));
    const session = await createSession(app, { provider: "nvidia" });

    const response = await send(app, session.id, { content: "Hi" }, { "x-llm-api-key": KEY });

    expect(response.statusCode).toBe(502);
    const { assistantMessage }: Turn = response.json();
    expect(assistantMessage).toMatchObject({
      status: "failed",
      errorCode: "llm_upstream_error",
      content: "half an answer",
    });
  });

  it("fails with llm_context_overflow when upstream says the context is too long", async () => {
    app = makeHostedTestApp({ db: testDb.db });
    upstream.reply(
      errorOf(400, {
        object: "error",
        message: "This model's maximum context length is 32768 tokens.",
      }),
    );
    const session = await createSession(app, { provider: "nvidia" });

    const response = await send(app, session.id, { content: "Hi" }, { "x-llm-api-key": KEY });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ code: "llm_context_overflow" });
  });

  it("keeps the upstream account id out of the stored and returned detail and every log line", async () => {
    const logs = captureLogs();
    app = makeHostedTestApp({ db: testDb.db, env: { LOG_LEVEL: "trace" }, logStream: logs.stream });
    upstream.reply(
      errorOf(404, {
        status: 404,
        title: "Not Found",
        detail: "Function 'fn-42': Not found for account 'acct-123'",
      }),
    );
    const session = await createSession(app, { provider: "nvidia" });

    const response = await send(app, session.id, { content: "Hi" }, { "x-llm-api-key": KEY });

    expect(response.statusCode).toBe(502);
    const expected =
      "The model provider answered HTTP 404: Function 'fn-42': Not found for account '[REDACTED]'";
    const { assistantMessage }: Turn = response.json();
    expect(response.json()).toMatchObject({ detail: expected });
    expect(assistantMessage.errorDetail).toBe(expected);
    const stored = await getMessage(app, session.id, assistantMessage.id);
    expect(stored.json()).toMatchObject({ errorDetail: expected });
    expect(stored.body).not.toContain("acct-123");
    expect(response.body).not.toContain("acct-123");
    expect(logs.lines().length).toBeGreaterThan(0);
    expect(logs.lines().filter((line) => line.includes("acct-123"))).toEqual([]);
  });
});
