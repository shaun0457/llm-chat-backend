import { describe, expect, it } from "vitest";

import { LlmError } from "../../src/llm/errors.js";
import { isTransientUpstreamFailure, liveCheckEnabled } from "../helpers/live.js";

describe("liveCheckEnabled", () => {
  it.each([
    [{}, false],
    [{ CI: "true" }, false],
    [{ NVIDIA_API_KEY: "nvapi-test-0000" }, false],
    [{ LLM_LIVE_TESTS: "1" }, false],
    [{ LLM_LIVE_TESTS: "1", NVIDIA_API_KEY: "" }, false],
    [{ LLM_LIVE_TESTS: "true", NVIDIA_API_KEY: "nvapi-test-0000" }, false],
    [{ LLM_LIVE_TESTS: "1", NVIDIA_API_KEY: "nvapi-test-0000" }, true],
    [{ LLM_LIVE_TESTS: "1", NVIDIA_API_KEY: "nvapi-test-0000", CI: "true" }, true],
  ])("%j → %s", (env, expected) => {
    expect(liveCheckEnabled(env)).toBe(expected);
  });
});

describe("isTransientUpstreamFailure", () => {
  it.each([
    [new LlmError("llm_upstream_error", "The model provider answered HTTP 429: slow down"), true],
    [new LlmError("llm_upstream_error", "The model provider answered HTTP 503: busy"), true],
    [new LlmError("llm_upstream_error", "The model provider answered HTTP 404: no model"), false],
    [new LlmError("llm_auth_failed", "The model provider answered HTTP 401: bad key"), false],
    [new LlmError("llm_timeout", "The model provider did not answer in time."), true],
    [new DOMException("The operation was aborted due to timeout", "TimeoutError"), true],
    [new DOMException("This operation was aborted", "AbortError"), false],
    [new Error("The model provider answered HTTP 503: busy"), false],
  ])("%s → %s", (error, expected) => {
    expect(isTransientUpstreamFailure(error)).toBe(expected);
  });
});
