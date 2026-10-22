import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
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
      // Room for a reasoning model's reasoning before the short answer (#36).
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
      const started = performance.now();
      const events = await streamOnce(model);
      const totalMs = Math.round(performance.now() - started);

      const text = events.map((event) => (event.type === "delta" ? event.text : "")).join("");
      const finishes = events.filter((event) => event.type === "finish");
      const finish = finishes[0];
      // V2: usage is reported only if the provider honours stream_options.include_usage.
      report({
        model,
        finishReason: finish?.reason ?? null,
        usage: finish?.usage ?? null,
        totalMs,
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
