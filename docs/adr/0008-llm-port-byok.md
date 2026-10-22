# ADR 0008: LLM port, OpenAI-compatible adapter, and bring-your-own-key without storing keys

- Status: accepted
- Date: 2026-10-22

## Context

Only the keyless demo provider existed. Users want a real hosted model with their own API key,
and the key must never reach the database, the logs or any response, including inside upstream
error messages, which sometimes echo request details. Upstream APIs also misbehave in ways that
must not corrupt an answer: usage in a separate chunk, streams ending without a finish reason,
reasoning text in side fields, rate limits and wrong keys.

## Options considered

- **Our own HTTP client for the chat completions API**: full control, but it would reimplement
  SSE parsing, retries with `Retry-After`, timeouts and error classes that the official SDK
  already has and keeps up to date.
- **The official `openai` SDK with one shared client per provider**: simple, but a shared
  client holds one key, so per-request keys would need per-call overrides, and a mistake would
  send one user's key on another user's request.
- **The official SDK with a client per call** (chosen): each call builds its client with that
  call's key and the server-configured base URL; nothing outlives the call.
- **Storing users' keys server-side** (encrypted, referenced by id): out of scope by design.
  The service has no accounts, so there is nobody to own a stored key.

## Decision

- **Port.** `LlmProvider.stream(request, { signal, apiKey })` yields `delta` events and exactly
  one `finish` (`stop`, `length` or `other`, with usage or `null`). Requests use this service's
  own types. Modules depend on the port and registry, never on an adapter (lint rule).
- **Adapter** (`OpenAiCompatibleProvider`). Per call: `new OpenAI({ apiKey, baseURL, timeout:
60_000, maxRetries: 2, logLevel: "off", organization: null, project: null })`, then
  `chat.completions.create({ model, messages, max_tokens, stream: true, stream_options: {
include_usage: true } }, { signal })`. A keyless call passes the placeholder `no-key`, which
  the SDK requires and keyless servers ignore; the SDK never falls back to `OPENAI_API_KEY`.
  Finish reason and usage are accumulated separately, because usage may arrive in a later chunk
  with empty `choices`. A stream that ends without a finish reason throws `llm_upstream_error`,
  and the worker keeps the partial text. Only `choices[0].delta.content` becomes text;
  reasoning side fields are ignored.
- **Error mapping** (after the SDK's retries), into an `LlmError` with a code and a detail of at
  most 500 characters, scrubbed before it is cut:
  - 401/403 → `llm_auth_failed`, never retried by the SDK;
  - 400/413/422 whose code is `context_length_exceeded`, or whose message talks about the
    context length or window → `llm_context_overflow`;
  - an SDK timeout → `llm_timeout`;
  - 429, 5xx, connection errors, error events inside the stream, malformed streams, a missing
    finish reason → `llm_upstream_error`.

  The SDK keeps only an OpenAI-style `error` object from an error body, so the adapter passes
  the SDK a `fetch` that remembers the last failed response body of that call. This finds the
  message in vLLM (`message`) and RFC 9457 (`detail`) formats too. When the caller's signal
  aborts (fencing, shutdown, deadline), the adapter rethrows the abort reason unchanged, so the
  caller can tell it from an upstream failure. `LlmError` carries no `cause`, so nothing of the
  SDK error can be logged through it.

- **Credential decision**, once per new turn inside the admission transaction, after the
  provider is resolved: the `X-LLM-Api-Key` header (validated by the route schema as 1–512
  visible ASCII characters, a 400 otherwise, never echoed) → the operator key
  `<PROVIDER>_API_KEY` of the turn's provider (read at startup for enabled providers only) →
  `null` for a provider with `requiresKey: false` → otherwise 422 `llm_credential_missing`
  before any row is written. Replays (a later ticket) never reach this step.
- **Key lifetime.** The decided key goes into the job and nowhere else: no request decoration,
  no logging context, no error object. It is held by an `ApiKey` object whose private field
  serialises as `[REDACTED]` (JSON, `util.inspect`, string conversion), revealed only for the
  provider call, and cleared in the job's `finally`. Nothing re-resolves a key later.
- **Scrubbing.** `scrub(text, key)` removes the literal key, `Bearer <token>`, `api_key=` /
  `apikey=` / `api-key=` / `key=` values and recognisable key formats (`nvapi-…`, `sk-…`). It
  is applied to every upstream text before it is stored, returned or logged.
- **Logging.** pino redacts the credential headers and `apiKey` fields up to three levels
  deep, and the `err` serializer is an allowlist: type, message, stack, code, status and, for
  database errors, constraint, table and column, along the cause chain. SDK request options
  and headers, `pg` error `detail`/`where` and drizzle's query parameters (replaced by
  `[omitted]` in the message) are never written. The SDK's own logger is off.
- **Base URLs** come only from server configuration (`NVIDIA_BASE_URL`, default
  `https://integrate.api.nvidia.com/v1`, `http`/`https` only). Clients cannot choose a host.
- **Catalog.** Only models expected to stream their answer without inline reasoning are listed:
  `google/gemma-3-12b-it` (default) and `nvidia/llama-3.1-nemotron-70b-instruct`, both with a
  conservative 32,768-token context window and 2,048 output tokens.

## Verification findings

- **V1 msw and the SDK:** msw 2.15 intercepts the SDK's calls: the SDK takes the global `fetch`
  when the client is built, after msw patched it (contract test "sends the request with the
  call's key to the configured base URL"). One trap: with a string or byte body, msw never
  settles the SDK's cancellation of the response body, which the SDK performs after `[DONE]`
  and before a retry, so the call hangs. The test helper therefore always answers with a
  `ReadableStream` body. A real server (checked with `node:http`) does not have the problem.
- **V2 NVIDIA's API:** the base URL is `https://integrate.api.nvidia.com/v1` (its public
  `GET /models` lists the models). Probed without a valid key: a malformed key gets 401 and an
  unrecognised one 403, both as problem details (`{"status","title","detail"}`) that did not
  echo the key; an unknown model gets 404 and a retired one 410 with a problem-details
  `detail`. Whether `stream_options.include_usage` is accepted and how context overflow is
  reported could not be checked without a key: **live check pending**. Since nothing showed the
  option being rejected, no per-provider option to omit it was built; an accepted request
  without usage yields `usage: null` (contract-tested). The context mapping covers the OpenAI,
  vLLM and problem-details formats by status and message.
- **V3 reasoning in content:** the two catalogued models are instruction models without a
  reasoning mode. A live stream per model is **pending** (needs a key); the optional test
  `test/adapters/nvidia-live.test.ts` checks for `<think>` in the text, exactly one finish
  and the presence of usage, and runs only when `NVIDIA_API_KEY` is set outside CI.
- **V4 SDK retries and timeout** (openai 7.28.0 source, `client.js`): `shouldRetry` retries
  408, 409, 429 and every status ≥ 500, plus connection errors and timeouts; 401/403 are not
  retried, unless the server sends `x-should-retry: true`, which the SDK obeys. Retries honour
  `retry-after-ms` / `Retry-After` up to 60 s, otherwise back off from 0.5 s to at most 8 s.
  `timeout` applies per HTTP attempt and covers the time until the response headers; a
  streaming body is not bounded by it. Contract tests: 401 and 403 → one request; 429 then a
  stream → two; persistent 503 → three; a response slower than a shortened timeout →
  `llm_timeout` after three requests.

## Consequences

- A key is necessarily in process memory while its generation runs; a restart loses both, and
  the answer is retried with the key sent again.
- Upstream error formats differ by provider: the mapping relies on the status first and
  best-effort message matching for context overflow. An upstream (server-configured, so
  trusted) could force a retry of a 401 with `x-should-retry: true`.
- A stream that stalls after its headers is not ended by the SDK timeout; the per-attempt
  generation deadline ends it.
- Adding an OpenAI-compatible provider (for example a local model) means a catalog entry, a
  base URL setting and one line in `server.ts`, with no key for a keyless server.
- Ordinary error messages could in principle contain a key the serializer cannot recognise;
  the adapter therefore only ever throws already-scrubbed `LlmError`s, and other code never
  sees a key.
