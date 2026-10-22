import OpenAI from "openai";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { scrub } from "../../src/credentials/scrub.js";
import { loadCatalog } from "../../src/llm/catalog.js";
import { OpenAiCompatibleProvider } from "../../src/llm/openai-compatible.js";
import type { LlmEvent, LlmRequest } from "../../src/llm/port.js";
import { isTransientUpstreamFailure, liveCheckEnabled } from "../helpers/live.js";

/**
 * Live check against NVIDIA's hosted API (ADR 0008, V2/V3). Opt-in: it runs only with
 * LLM_LIVE_TESTS=1 and NVIDIA_API_KEY set, so an exported key alone never makes `pnpm test`
 * call a paid API. CI runs it only in the `live-llm` workflow. The key is read from the
 * environment and never printed: each result line holds the model id, finish reason, usage and
 * the start of the answer, nothing else.
 */
const key = process.env.NVIDIA_API_KEY;
const live = liveCheckEnabled(process.env);

/** Inline reasoning some models emit in their content (V3). */
const INLINE_REASONING = /<\/?(think|thinking|reasoning|thought)>/i;

/** NVIDIA queues requests when a model is busy, so one call may wait this long. */
const CALL_TIMEOUT_MS = 90_000;

function report(result: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- the result line is this check's report
  console.log(`LIVE_RESULT ${JSON.stringify(result)}`);
}

describe.skipIf(!live)("nvidia live", { timeout: 2 * CALL_TIMEOUT_MS + 10_000 }, () => {
  const config = loadConfig({ DATABASE_URL: "postgres://unused@127.0.0.1:9/unused" });
  const models = loadCatalog(config.modelCatalogPath).provider("nvidia")?.models ?? [];
  const provider = new OpenAiCompatibleProvider({ id: "nvidia", baseUrl: config.nvidiaBaseUrl });

  it("has catalogued NVIDIA models to check", () => {
    expect(models.length).toBeGreaterThan(0);
  });

  /** One short streaming call, attempted a second time only after a 429 or 5xx. */
  async function streamOnce(model: string): Promise<LlmEvent[]> {
    const request: LlmRequest = {
      model,
      maxOutputTokens: 1024,
      messages: [
        { role: "system", content: "Answer in one short sentence." },
        { role: "user", content: "What is the capital of France?" },
      ],
    };
    for (let attempt = 1; ; attempt += 1) {
      const events: LlmEvent[] = [];
      try {
        for await (const event of provider.stream(request, {
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
          apiKey: key ?? null,
        })) {
          events.push(event);
        }
        return events;
      } catch (error) {
        if (attempt >= 2 || !isTransientUpstreamFailure(error)) {
          // Adapter errors are already scrubbed; a timeout carries no upstream text.
          report({
            model,
            error: error instanceof Error ? `${error.name}: ${error.message}` : "?",
          });
          throw error;
        }
      }
    }
  }

  it.concurrent.each(models.map((model) => [model.id]))(
    "%s streams an answer without inline reasoning, with one finish",
    async (model) => {
      const events = await streamOnce(model);

      const text = events.map((event) => (event.type === "delta" ? event.text : "")).join("");
      const finishes = events.filter((event) => event.type === "finish");
      const finish = finishes[0];
      // V2: usage is reported only if the provider honours stream_options.include_usage.
      report({
        model,
        finishReason: finish?.reason ?? null,
        usage: finish?.usage ?? null,
        answer: text.slice(0, 80),
      });

      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).not.toMatch(INLINE_REASONING);
      expect(finishes).toHaveLength(1);
      // V2: the provider honours stream_options.include_usage (checked 2026-10-22).
      expect(finish?.usage).not.toBeNull();
    },
  );
});

// TEMPORARY verify-first probe for #36 (V1-V4); removed before the PR is ready.
describe.skipIf(!live)("nvidia probe (#36 verify first)", { timeout: 15 * 60_000 }, () => {
  const config = loadConfig({ DATABASE_URL: "postgres://unused@127.0.0.1:9/unused" });
  const MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
  const PROBE_TIMEOUT_MS = 60_000;
  type Msg = { role: "system" | "user"; content: string };
  const prompts: Record<string, Msg[]> = {
    capital: [
      { role: "system", content: "Answer in one short sentence." },
      { role: "user", content: "What is the capital of France?" },
    ],
    index150: [
      { role: "user", content: "Explain in at most 150 characters what a database index is." },
    ],
    water3: [{ role: "user", content: "Describe the water cycle in three sentences." }],
    batball: [
      {
        role: "user",
        content:
          "A bat and a ball cost 1.10 dollars in total. The bat costs 1.00 dollar more than the ball. How much does the ball cost? Answer briefly.",
      },
    ],
  };
  const variants: Array<[string, Record<string, unknown>, string[]]> = [
    ["default", {}, ["capital", "index150", "water3", "batball"]],
    [
      "thinkingOn",
      { chat_template_kwargs: { enable_thinking: true } },
      ["capital", "index150", "water3", "batball"],
    ],
    ["thinkingOff", { chat_template_kwargs: { enable_thinking: false } }, ["capital", "water3"]],
  ];

  function probeReport(result: Record<string, unknown>): void {
    // eslint-disable-next-line no-console -- the probe's report
    console.log(`LIVE_PROBE ${JSON.stringify(result)}`);
  }

  it("V1: the served context window, from an oversized max_tokens", async () => {
    const provider = new OpenAiCompatibleProvider({
      id: "nvidia",
      baseUrl: config.nvidiaBaseUrl,
      maxRetries: 0,
    });
    try {
      for await (const event of provider.stream(
        { model: MODEL, maxOutputTokens: 4_000_000, messages: [{ role: "user", content: "Hi" }] },
        { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), apiKey: key ?? null },
      )) {
        if (event.type === "finish") {
          probeReport({ probe: "V1", accepted: true, usage: event.usage, reason: event.reason });
        }
      }
    } catch (error) {
      probeReport({
        probe: "V1",
        error: error instanceof Error ? `${error.name}: ${error.message}` : "?",
      });
    }
  });

  it("V2/V3/V4: reasoning field, size, usage and timings per variant", async () => {
    const client = new OpenAI({
      apiKey: key ?? "",
      baseURL: config.nvidiaBaseUrl,
      maxRetries: 0,
      timeout: PROBE_TIMEOUT_MS,
      logLevel: "off",
    });
    for (const [variant, extra, names] of variants) {
      for (const name of names) {
        const started = performance.now();
        const at = (): number => Math.round(performance.now() - started);
        let firstChunkMs: number | null = null;
        let firstReasoningMs: number | null = null;
        let firstContentMs: number | null = null;
        const deltaKeys = new Set<string>();
        const reasoningChars: Record<string, number> = {};
        let content = "";
        let finishReason: string | null = null;
        let usage: unknown = null;
        let chunks = 0;
        try {
          const stream = await client.chat.completions.create(
            {
              model: MODEL,
              messages: prompts[name] ?? [],
              max_tokens: 4096,
              stream: true,
              stream_options: { include_usage: true },
              ...extra,
            } as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
            { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
          );
          for await (const chunk of stream) {
            chunks += 1;
            firstChunkMs ??= at();
            const choice = chunk.choices?.[0];
            const delta = (choice?.delta ?? {}) as Record<string, unknown>;
            for (const [field, value] of Object.entries(delta)) {
              deltaKeys.add(`${field}:${value === null ? "null" : typeof value}`);
              if (
                field !== "content" &&
                field !== "role" &&
                typeof value === "string" &&
                value.length > 0
              ) {
                reasoningChars[field] = (reasoningChars[field] ?? 0) + value.length;
                firstReasoningMs ??= at();
              }
            }
            if (typeof delta.content === "string" && delta.content.length > 0) {
              firstContentMs ??= at();
              content += delta.content;
            }
            if (typeof choice?.finish_reason === "string") {
              finishReason = choice.finish_reason;
            }
            if (chunk.usage !== undefined && chunk.usage !== null) {
              usage = chunk.usage;
            }
          }
          probeReport({
            probe: "V2",
            variant,
            prompt: name,
            chunks,
            deltaKeys: [...deltaKeys].sort(),
            reasoningChars,
            contentChars: content.length,
            finishReason,
            usage,
            firstChunkMs,
            firstReasoningMs,
            firstContentMs,
            totalMs: at(),
            answer: content.slice(0, 120),
          });
        } catch (error) {
          probeReport({
            probe: "V2",
            variant,
            prompt: name,
            totalMs: at(),
            error: scrub(
              error instanceof Error ? `${error.name}: ${error.message}` : "?",
              key ?? null,
            ),
          });
        }
      }
    }
  });
});
