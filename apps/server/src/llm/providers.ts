import type { AppConfig } from "../config.js";
import { DemoProvider } from "./demo.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";
import type { LlmProvider } from "./port.js";

/** Until the first chunk and between chunks; below the 180 s generation deadline. */
const OLLAMA_TIMEOUT_MS = 120_000;

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
    ollama: new OpenAiCompatibleProvider({
      id: "ollama",
      baseUrl: config.ollamaBaseUrl,
      // A CPU model may load and read the prompt for over a minute before its first token,
      // and a retry would redo all of that work inside the same generation deadline.
      timeoutMs: OLLAMA_TIMEOUT_MS,
      maxRetries: 0,
    }),
  };
}
