import { LlmError } from "../../src/llm/errors.js";

/**
 * Whether the live hosted-LLM check runs: only with LLM_LIVE_TESTS=1 and a non-empty
 * NVIDIA_API_KEY. The regular CI job sets neither, so it skips there; `CI` itself is ignored,
 * because the `live-llm` workflow runs in CI too.
 */
export function liveCheckEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const key = env.NVIDIA_API_KEY;
  return env.LLM_LIVE_TESTS === "1" && key !== undefined && key.length > 0;
}

/**
 * A failure worth one more attempt in the live check: the upstream answered 429 or 5xx even
 * after the SDK's own retries, or a queued request got no answer in time (NVIDIA queues
 * requests to busy models). Anything else (auth, an unavailable model, a wrong answer) is final.
 */
export function isTransientUpstreamFailure(error: unknown): boolean {
  if (error instanceof LlmError) {
    return (
      error.code === "llm_timeout" ||
      (error.code === "llm_upstream_error" &&
        /^The model provider answered HTTP (429|5\d\d)\b/.test(error.detail))
    );
  }
  return error instanceof Error && error.name === "TimeoutError";
}
