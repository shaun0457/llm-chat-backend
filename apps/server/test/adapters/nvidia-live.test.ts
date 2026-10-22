import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { loadCatalog } from "../../src/llm/catalog.js";
import { OpenAiCompatibleProvider } from "../../src/llm/openai-compatible.js";
import type { LlmEvent } from "../../src/llm/port.js";

/**
 * Optional live check against NVIDIA's hosted API (ADR 0008, V2/V3). Opt-in: runs only with
 * LLM_LIVE_TESTS=1 and NVIDIA_API_KEY set, and never in CI, so an exported key alone never
 * makes `pnpm test` call a paid API. The key is read from the environment and written nowhere.
 */
const key = process.env.NVIDIA_API_KEY;
const live =
  process.env.LLM_LIVE_TESTS === "1" &&
  key !== undefined &&
  key.length > 0 &&
  process.env.CI === undefined;

describe.skipIf(!live)("nvidia live", { timeout: 120_000 }, () => {
  const config = loadConfig({ DATABASE_URL: "postgres://unused@127.0.0.1:9/unused" });
  const models = loadCatalog(config.modelCatalogPath).provider("nvidia")?.models ?? [];
  const provider = new OpenAiCompatibleProvider({ id: "nvidia", baseUrl: config.nvidiaBaseUrl });

  it.each(models.map((model) => [model.id]))(
    "%s streams an answer without inline reasoning, with one finish",
    async (model) => {
      const events: LlmEvent[] = [];
      for await (const event of provider.stream(
        {
          model,
          maxOutputTokens: 64,
          messages: [
            { role: "system", content: "Answer in one short sentence." },
            { role: "user", content: "What is the capital of France?" },
          ],
        },
        { signal: AbortSignal.timeout(60_000), apiKey: key ?? null },
      )) {
        events.push(event);
      }

      const text = events.map((event) => (event.type === "delta" ? event.text : "")).join("");
      const finishes = events.filter((event) => event.type === "finish");
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/<\/?think>/i);
      expect(finishes).toHaveLength(1);
      // V2: whether the provider honours stream_options.include_usage (null means it does not).
      expect(finishes[0]).toHaveProperty("usage");
    },
  );
});
