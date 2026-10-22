import OpenAI from "openai";

import { LlmError, toLlmError } from "./errors.js";
import type {
  LlmEvent,
  LlmFinishReason,
  LlmProvider,
  LlmRequest,
  LlmStreamOptions,
  LlmUsage,
} from "./port.js";

export type OpenAiCompatibleOptions = Readonly<{
  /** The provider id this adapter serves, e.g. "nvidia". */
  id: string;
  /** Server configuration only; never taken from a request. */
  baseUrl: string;
  /** Per HTTP attempt, until the response headers arrive. Default 60 s. */
  timeoutMs?: number;
  /** SDK retries on 408/409/429/5xx and connection errors; never on 401/403. Default 2. */
  maxRetries?: number;
}>;

/** The SDK insists on a key; keyless servers (e.g. a local model) ignore this one. */
const KEYLESS_PLACEHOLDER = "no-key";

/** How much of an upstream error body is read at most. */
const MAX_ERROR_BODY_BYTES = 8192;
/** Statuses whose Response must not have a body. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

/** The first `maxBytes` (roughly) of a body as text; the rest is never read. */
async function readStart(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return "";
  }
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    return text;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function finishReason(value: string): LlmFinishReason {
  return value === "stop" || value === "length" ? value : "other";
}

/**
 * An LlmProvider for any OpenAI-compatible chat completions API, on the official SDK. One
 * client per call, so no client outlives the call's key.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;

  constructor(options: OpenAiCompatibleOptions) {
    this.id = options.id;
    this.#baseUrl = options.baseUrl;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#maxRetries = options.maxRetries ?? 2;
  }

  async *stream(
    request: LlmRequest,
    { signal, apiKey }: LlmStreamOptions,
  ): AsyncIterable<LlmEvent> {
    // The SDK keeps only part of an error body; the mapping needs all of it (e.g. a vLLM or
    // problem-details message saying the context is too long). One client per call, so this
    // holds the (bounded) body of this call's last failed response only.
    let errorBody: string | undefined;
    const recordingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (response.ok) {
        return response;
      }
      // An error body is read only up to a bound, and the SDK gets that bounded copy, so a
      // huge or endless error body can neither fill memory nor hang the call.
      errorBody = await readStart(response, MAX_ERROR_BODY_BYTES);
      return new Response(NULL_BODY_STATUSES.has(response.status) ? null : errorBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
    const client = new OpenAI({
      apiKey: apiKey ?? KEYLESS_PLACEHOLDER,
      baseURL: this.#baseUrl,
      timeout: this.#timeoutMs,
      maxRetries: this.#maxRetries,
      fetch: recordingFetch,
      // Never read from the environment: an operator's OpenAI settings must not leak upstream.
      organization: null,
      project: null,
      // The SDK's own logging could print request details; this service logs on its own terms.
      logLevel: "off",
    });

    try {
      const chunks = await client.chat.completions.create(
        {
          model: request.model,
          messages: request.messages.map(({ role, content }) => ({ role, content })),
          max_tokens: request.maxOutputTokens,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal },
      );

      // Finish reason and usage are accumulated separately: usage may come in a later chunk.
      let reason: LlmFinishReason | undefined;
      let usage: LlmUsage | null = null;
      for await (const chunk of chunks) {
        const choice = chunk.choices[0];
        // Only answer content becomes text; reasoning side fields are ignored.
        const text = choice?.delta.content;
        if (typeof text === "string" && text.length > 0) {
          yield { type: "delta", text };
        }
        if (typeof choice?.finish_reason === "string") {
          reason = finishReason(choice.finish_reason);
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
          };
        }
      }
      if (reason === undefined) {
        throw new LlmError(
          "llm_upstream_error",
          "The model provider ended the answer without a finish reason.",
        );
      }
      yield { type: "finish", reason, usage };
    } catch (error) {
      // The caller's abort (fencing, shutdown, deadline) is theirs to interpret, not an
      // upstream failure.
      if (signal.aborted) {
        throw signal.reason;
      }
      throw toLlmError(error, apiKey, errorBody);
    }
  }
}
