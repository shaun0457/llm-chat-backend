import { describe, expect, it, vi } from "vitest";

import { OpenAiCompatibleProvider } from "../../src/llm/openai-compatible.js";
import type { LlmEvent, LlmRequest } from "../../src/llm/port.js";
import {
  UPSTREAM_BASE_URL,
  endlessErrorOf,
  errorOf,
  rawStream,
  slow,
  streamOf,
  useUpstream,
} from "../helpers/msw-openai.js";

const KEY = "test-key-not-real-1234";
const REQUEST: LlmRequest = {
  model: "vendor/chat-model",
  maxOutputTokens: 256,
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Hi" },
  ],
};

const upstream = useUpstream();

function provider(options: { timeoutMs?: number } = {}): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({ id: "hosted", baseUrl: UPSTREAM_BASE_URL, ...options });
}

async function collect(
  events: AsyncIterable<LlmEvent>,
  into: LlmEvent[] = [],
): Promise<LlmEvent[]> {
  for await (const event of events) {
    into.push(event);
  }
  return into;
}

function stream(
  options: { apiKey?: string | null; signal?: AbortSignal; timeoutMs?: number } = {},
): AsyncIterable<LlmEvent> {
  return provider({ timeoutMs: options.timeoutMs }).stream(REQUEST, {
    signal: options.signal ?? new AbortController().signal,
    apiKey: options.apiKey === undefined ? KEY : options.apiKey,
  });
}

describe("OpenAiCompatibleProvider", () => {
  describe("contract.stream", () => {
    it("emits each content chunk as a delta, then one finish with reason and usage", async () => {
      upstream.reply(
        streamOf([
          { content: "He" },
          { content: "llo" },
          { finishReason: "stop", usage: { prompt_tokens: 12, completion_tokens: 2 } },
        ]),
      );

      const events = await collect(stream());

      expect(events).toEqual([
        { type: "delta", text: "He" },
        { type: "delta", text: "llo" },
        { type: "finish", reason: "stop", usage: { promptTokens: 12, completionTokens: 2 } },
      ]);
    });

    it("sends the request with the call's key to the configured base URL (V1: msw sees it)", async () => {
      upstream.reply(streamOf([{ content: "ok", finishReason: "stop" }]));

      await collect(stream());

      expect(upstream.requests).toHaveLength(1);
      expect(upstream.requests[0]?.authorization).toBe(`Bearer ${KEY}`);
      expect(upstream.requests[0]?.body).toEqual({
        model: "vendor/chat-model",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "Hi" },
        ],
        max_tokens: 256,
        stream: true,
        stream_options: { include_usage: true },
      });
    });

    it("takes usage from a later chunk with empty choices", async () => {
      upstream.reply(
        streamOf([
          { content: "Hi" },
          { finishReason: "length" },
          { noChoices: true, usage: { prompt_tokens: 30, completion_tokens: 256 } },
        ]),
      );

      const events = await collect(stream());

      expect(events).toEqual([
        { type: "delta", text: "Hi" },
        { type: "finish", reason: "length", usage: { promptTokens: 30, completionTokens: 256 } },
      ]);
    });

    it("finishes with usage null when the stream carries no usage", async () => {
      upstream.reply(streamOf([{ content: "Hi" }, { finishReason: "stop" }]));

      const events = await collect(stream());

      expect(events.at(-1)).toEqual({ type: "finish", reason: "stop", usage: null });
    });

    it("tolerates chunks without a delta or without choices", async () => {
      upstream.reply(
        rawStream(
          [
            { choices: [{ index: 0, delta: { content: "Hi" } }] },
            { choices: [{ index: 0, finish_reason: "stop" }] },
            { usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
          ]
            .map((data) => `data: ${JSON.stringify(data)}\n\n`)
            .join("") + "data: [DONE]\n\n",
        ),
      );

      const events = await collect(stream());

      expect(events).toEqual([
        { type: "delta", text: "Hi" },
        { type: "finish", reason: "stop", usage: { promptTokens: 3, completionTokens: 1 } },
      ]);
    });

    it("maps any other finish reason to other", async () => {
      upstream.reply(streamOf([{ content: "Hi" }, { finishReason: "content_filter" }]));

      const events = await collect(stream());

      expect(events.at(-1)).toEqual({ type: "finish", reason: "other", usage: null });
    });

    it("sends only the headers it needs, never extra headers from the environment", async () => {
      upstream.reply(streamOf([{ content: "ok", finishReason: "stop" }]));
      process.env.OPENAI_CUSTOM_HEADERS = "X-Leak: operator-secret";
      try {
        await collect(stream());
      } finally {
        delete process.env.OPENAI_CUSTOM_HEADERS;
      }

      const names = Object.keys(upstream.requests[0]?.headers ?? {});
      expect(names).not.toContain("x-leak");
      expect(names.filter((name) => name.startsWith("x-"))).toEqual([]);
      expect(names).toContain("authorization");
    });

    it("uses a placeholder key for a keyless call, never an environment key", async () => {
      upstream.reply(streamOf([{ content: "ok", finishReason: "stop" }]));

      await collect(stream({ apiKey: null }));

      expect(upstream.requests[0]?.authorization).toBe("Bearer no-key");
    });
  });

  describe("contract.eof", () => {
    it("fails with llm_upstream_error after the deltas when no finish reason arrived", async () => {
      upstream.reply(streamOf([{ content: "par" }, { content: "tial" }]));
      const seen: LlmEvent[] = [];

      await expect(collect(stream(), seen)).rejects.toMatchObject({
        name: "LlmError",
        code: "llm_upstream_error",
      });
      expect(seen).toEqual([
        { type: "delta", text: "par" },
        { type: "delta", text: "tial" },
      ]);
    });

    it("also fails when the connection ends without [DONE] and without a finish reason", async () => {
      upstream.reply(streamOf([{ content: "par" }], { done: false }));

      await expect(collect(stream())).rejects.toMatchObject({ code: "llm_upstream_error" });
    });
  });

  describe("contract.errors", () => {
    const ok = streamOf([{ content: "ok", finishReason: "stop" }]);

    it.each([401, 403])("maps %i to llm_auth_failed without retrying", async (status) => {
      upstream.reply(
        errorOf(status, { status, title: "Forbidden", detail: "Authorization failed" }),
      );

      await expect(collect(stream())).rejects.toMatchObject({
        name: "LlmError",
        code: "llm_auth_failed",
      });
      expect(upstream.requests).toHaveLength(1);
    });

    it("succeeds after one retry when a 429 is followed by a stream", async () => {
      upstream.reply(errorOf(429, { error: { message: "Too many requests" } }), ok);

      const events = await collect(stream());

      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
      expect(upstream.requests).toHaveLength(2);
    });

    it("fails with llm_upstream_error after two retries of a persistent 503", async () => {
      upstream.reply(errorOf(503, { error: { message: "overloaded" } }));

      await expect(collect(stream())).rejects.toMatchObject({
        code: "llm_upstream_error",
        detail: expect.stringContaining("503"),
      });
      expect(upstream.requests).toHaveLength(3);
    });

    it.each([
      [
        "an OpenAI-style error code",
        { error: { message: "too long", code: "context_length_exceeded" } },
      ],
      [
        "a vLLM-style top-level message",
        {
          object: "error",
          message:
            "This model's maximum context length is 8192 tokens. However, you requested 9000.",
          code: 400,
        },
      ],
      ["a problem-details detail", { status: 400, detail: "Input exceeds the context window" }],
    ])("maps a 400 with %s to llm_context_overflow", async (_label, body) => {
      upstream.reply(errorOf(400, body));

      await expect(collect(stream())).rejects.toMatchObject({ code: "llm_context_overflow" });
      expect(upstream.requests).toHaveLength(1);
    });

    it("maps any other 400 to llm_upstream_error and keeps the upstream message", async () => {
      upstream.reply(errorOf(400, { error: { message: "Unknown parameter: foo" } }));

      await expect(collect(stream())).rejects.toMatchObject({
        code: "llm_upstream_error",
        detail: "The model provider answered HTTP 400: Unknown parameter: foo",
      });
    });

    it(
      "maps a response slower than the SDK timeout to llm_timeout",
      { timeout: 20_000 },
      async () => {
        upstream.reply(slow(2_000));

        await expect(collect(stream({ timeoutMs: 50 }))).rejects.toMatchObject({
          code: "llm_timeout",
        });
        // The SDK retries timeouts too: one request plus two retries.
        expect(upstream.requests).toHaveLength(3);
      },
    );

    it("maps an error event inside the stream to llm_upstream_error", async () => {
      upstream.reply(rawStream('data: {"error":{"message":"worker crashed"}}\n\n'));

      await expect(collect(stream())).rejects.toMatchObject({
        code: "llm_upstream_error",
        detail: expect.stringContaining("worker crashed"),
      });
    });

    it("scrubs the key and bearer tokens from the detail and limits it to 500 characters", async () => {
      upstream.reply(
        errorOf(401, {
          error: {
            message: `Invalid key ${KEY} (Authorization: Bearer ${KEY}) ${"x".repeat(900)}`,
          },
        }),
      );

      const error: unknown = await collect(stream()).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: "llm_auth_failed" });
      const { detail, message } = error as { detail: string; message: string };
      expect(detail).toContain("Invalid key [REDACTED] (Authorization: Bearer [REDACTED])");
      expect(detail.length).toBeLessThanOrEqual(500);
      expect(JSON.stringify(error)).not.toContain(KEY);
      expect(message).not.toContain(KEY);
      expect(error).not.toHaveProperty("cause");
    });

    it("rethrows the abort reason, not an upstream error, when the caller aborts", async () => {
      upstream.reply(slow(2_000));
      const controller = new AbortController();
      const reason = new Error("caller stopped");

      const result = collect(stream({ signal: controller.signal }));
      await vi.waitFor(() => expect(upstream.requests).toHaveLength(1));
      controller.abort(reason);

      await expect(result).rejects.toBe(reason);
    });

    it("reads only the start of an error body that never ends", { timeout: 10_000 }, async () => {
      upstream.reply(endlessErrorOf(500));

      await expect(collect(stream())).rejects.toMatchObject({ code: "llm_upstream_error" });
      expect(upstream.requests).toHaveLength(3);
    });
  });

  describe("contract.reasoning", () => {
    it("never turns a reasoning side field into text, and keeps finish reason and usage", async () => {
      upstream.reply(
        streamOf([
          { reasoning: "secret thoughts " },
          { reasoning: "more thoughts", content: "" },
          { content: "Answer" },
          {
            reasoning: "late thought",
            finishReason: "stop",
            usage: { prompt_tokens: 4, completion_tokens: 9 },
          },
        ]),
      );

      const events = await collect(stream());

      expect(events).toEqual([
        { type: "delta", text: "Answer" },
        { type: "finish", reason: "stop", usage: { promptTokens: 4, completionTokens: 9 } },
      ]);
    });
  });
});
