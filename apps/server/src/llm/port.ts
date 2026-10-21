/**
 * The one port every LLM provider implements. Requests and events are this service's own
 * types; adapters translate them to and from each provider's API.
 */
export type LlmMessage = Readonly<{ role: "system" | "user" | "assistant"; content: string }>;

export type LlmRequest = Readonly<{
  model: string;
  messages: readonly LlmMessage[];
  maxOutputTokens: number;
}>;

export type LlmUsage = Readonly<{ promptTokens: number; completionTokens: number }>;

export type LlmFinishReason = "stop" | "length" | "other";

export type LlmEvent =
  | Readonly<{ type: "delta"; text: string }>
  | Readonly<{ type: "finish"; reason: LlmFinishReason; usage: LlmUsage | null }>;

export type LlmStreamOptions = Readonly<{
  /** Aborting it ends the stream; the iteration then rejects (typically with an AbortError). */
  signal: AbortSignal;
  /** The caller's key for this one call, or null for keyless providers. Never stored. */
  apiKey: string | null;
}>;

export interface LlmProvider {
  readonly id: string;
  /** Yields deltas, then exactly one `finish`; throws on upstream failure or abort. */
  stream(request: LlmRequest, options: LlmStreamOptions): AsyncIterable<LlmEvent>;
}
