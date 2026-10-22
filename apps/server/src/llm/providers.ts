import type { AppConfig } from "../config.js";
import { DemoProvider } from "./demo.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";
import type { LlmProvider } from "./port.js";

/**
 * The implementation of every provider this server knows, by provider id. The registry keeps
 * only the enabled ones. Hosted and local models share the OpenAI-compatible adapter; only the
 * server-configured base URL differs, and a keyless provider is called with a placeholder key.
 */
export function createAdapters(
  config: Pick<AppConfig, "demoDelayMs" | "nvidiaBaseUrl" | "ollamaBaseUrl">,
): Readonly<Record<string, LlmProvider>> {
  return {
    demo: new DemoProvider({ delayMs: config.demoDelayMs }),
    nvidia: new OpenAiCompatibleProvider({ id: "nvidia", baseUrl: config.nvidiaBaseUrl }),
    ollama: new OpenAiCompatibleProvider({ id: "ollama", baseUrl: config.ollamaBaseUrl }),
  };
}
