import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";

import { scrub } from "../credentials/scrub.js";

/** The assistant error codes an upstream call can end with. */
export type UpstreamErrorCode =
  | "llm_auth_failed"
  | "llm_upstream_error"
  | "llm_timeout"
  | "llm_context_overflow";

/**
 * A failed upstream call, as this service reports it. `detail` is safe to store and return:
 * already scrubbed of credentials and bounded in length. Deliberately carries no `cause`, so
 * nothing from the SDK error (request options, headers, body) can be logged through it.
 */
export class LlmError extends Error {
  constructor(
    readonly code: UpstreamErrorCode,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "LlmError";
  }
}

export const DEFAULT_UPSTREAM_DETAIL = "The model provider returned an error.";
const MAX_DETAIL_LENGTH = 500;
/** How much of an upstream error body is looked at. */
const MAX_BODY_LENGTH = 4096;
const CONTEXT_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);
const CONTEXT_MESSAGE =
  /context[ _-]?(length|window)|maximum context|too many tokens|prompt is too long|input is too long/i;

/** Bounded after scrubbing, so a cut can never leave part of a key behind. */
function safeDetail(text: string, key: string | null): string {
  const scrubbed = scrub(text, key).replace(/\s+/g, " ").trim();
  return scrubbed.length <= MAX_DETAIL_LENGTH
    ? scrubbed
    : `${scrubbed.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
}

function stringAt(value: unknown, ...path: string[]): string | undefined {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" && current.length > 0 ? current : undefined;
}

/**
 * The human-readable message of an upstream error body in the formats seen in practice:
 * OpenAI (`error.message`), vLLM (`message`), RFC 9457 problem details (`detail`, `title`),
 * a bare string `error`, or plain text.
 */
function upstreamMessage(body: string | undefined): string | undefined {
  if (body === undefined || body.trim().length === 0) {
    return undefined;
  }
  const text = body.slice(0, MAX_BODY_LENGTH);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return text;
  }
  return (
    stringAt(json, "error", "message") ??
    stringAt(json, "message") ??
    stringAt(json, "detail") ??
    stringAt(json, "error") ??
    stringAt(json, "title")
  );
}

function upstreamCode(body: string | undefined, error: APIError): string | undefined {
  if (typeof error.code === "string") {
    return error.code;
  }
  try {
    return stringAt(JSON.parse(body?.slice(0, MAX_BODY_LENGTH) ?? ""), "error", "code");
  } catch {
    return undefined;
  }
}

/**
 * Maps anything an OpenAI-compatible call threw (after the SDK's own retries) to an LlmError.
 * `errorBody` is the raw body of the last failed HTTP response, when there was one.
 */
export function toLlmError(error: unknown, key: string | null, errorBody?: string): LlmError {
  if (error instanceof LlmError) {
    return error;
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new LlmError("llm_timeout", "The model provider did not answer in time.");
  }
  if (error instanceof APIUserAbortError || error instanceof APIConnectionError) {
    return new LlmError("llm_upstream_error", "The model provider could not be reached.");
  }
  if (error instanceof APIError) {
    const { status } = error;
    if (status === undefined) {
      // An error event inside an accepted stream.
      const message = stringAt(error.error, "message") ?? error.message;
      return new LlmError(
        "llm_upstream_error",
        safeDetail(`The model provider reported an error: ${message}`, key),
      );
    }
    const message = upstreamMessage(errorBody) ?? stringAt(error.error, "message");
    const detail = safeDetail(
      `The model provider answered HTTP ${status}${message === undefined ? "." : `: ${message}`}`,
      key,
    );
    if (status === 401 || status === 403) {
      return new LlmError("llm_auth_failed", detail);
    }
    const code = upstreamCode(errorBody, error);
    if (
      CONTEXT_STATUSES.has(status) &&
      (code === "context_length_exceeded" || CONTEXT_MESSAGE.test(message ?? ""))
    ) {
      return new LlmError("llm_context_overflow", detail);
    }
    return new LlmError("llm_upstream_error", detail);
  }
  if (error instanceof SyntaxError) {
    return new LlmError("llm_upstream_error", "The model provider sent a malformed stream.");
  }
  return new LlmError("llm_upstream_error", DEFAULT_UPSTREAM_DETAIL);
}
