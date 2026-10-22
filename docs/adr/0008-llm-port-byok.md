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
    finish reason, and (since the amendment for issue #36) a stream that finishes without any
    answer text → `llm_upstream_error`.

  The SDK keeps only an OpenAI-style `error` object from an error body, so the adapter passes
  the SDK a `fetch` that remembers the last failed response body of that call. This finds the
  message in vLLM (`message`) and RFC 9457 (`detail`) formats too. When the caller's signal
  aborts (fencing, shutdown, deadline), the adapter rethrows the abort reason unchanged, so the
  caller can tell it from an upstream failure. `LlmError` carries no `cause`, so nothing of the
  SDK error can be logged through it.

- **Credential decision** (superseded for keyless providers by the
  [#33 amendment](#amendment-2026-10-22-issue-33-keyless-providers-never-receive-a-key): they
  never receive a key), once per new turn inside the admission transaction, after the
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
- **Scrubbing** also covers the key as JSON-escaped and URL-encoded text, and partially masked
  echoes such as `sk-proj-****abcd`.
- **Base URLs** come only from server configuration (`NVIDIA_BASE_URL`, default
  `https://integrate.api.nvidia.com/v1`, `http`/`https` only, no credentials in the URL).
  Clients cannot choose a host, and the adapter never follows a redirect (`redirect: "error"`).
- **Outgoing headers** are an allowlist: `authorization`, `content-type`, `accept` and
  `user-agent`. The SDK would also send `x-stainless-*` telemetry about this host and any
  headers an operator configured in `OPENAI_CUSTOM_HEADERS`, which the SDK reads from the
  environment even when every other option is explicit.
- **Error bodies** are read up to 8 KiB, and the SDK gets that bounded copy, so a huge or
  endless body can neither fill memory nor hang a call. The body is scrubbed whole before any
  part of it is cut.
- **Catalog.** Only models that streamed a clean answer in the live check are listed:
  `meta/llama-3.2-11b-vision-instruct` (default), with a conservative 32,768-token context
  window and 2,048 output tokens (not measured). A unit test pins the shipped NVIDIA list, so
  adding a model means running the live check first. Superseded by the amendment for issue
  #36: the catalog is now `nvidia/nemotron-3-ultra-550b-a55b`, a reasoning model.

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
  `detail`. With a real key (the `live-llm` workflow, 2026-10-22,
  [run 39718461460](https://github.com/shaun0457/llm-chat-backend/actions/runs/39718461460)): `stream_options.include_usage` is accepted, and every
  model that answered reported usage (e.g. 60 prompt and 8 completion tokens). A model the
  key's account cannot use answers 404 `Function '<id>': Not found for account '<account id>'`,
  also for models that the public `GET /models` lists. Context overflow was not probed live: it
  would cost about 32k tokens per check. The mapping covers the OpenAI, vLLM and
  problem-details formats by status and message; an unrecognised format falls back to
  `llm_upstream_error`.
- **V3 reasoning in content:** checked live with `test/adapters/nvidia-live.test.ts`: one
  short streaming call per model, asserting non-empty content, exactly one finish and no
  `<think>`-style tags. It runs only with `LLM_LIVE_TESTS=1` and `NVIDIA_API_KEY` set (in CI,
  only in the `live-llm` workflow). The two models first chosen from the docs,
  `google/gemma-3-12b-it` and `nvidia/llama-3.1-nemotron-70b-instruct`, answer 404 for the
  account, as did 12 other probed models. `meta/llama-3.2-11b-vision-instruct` passed and is
  the catalog. `openai/gpt-oss-20b` also passed (its reasoning arrives in a side field), but it
  is a reasoning model, which this ticket excluded (reversed by the amendment for issue #36).
  `nvidia/nemotron-3.5-lightning-30b-a3b` spent the whole output budget reasoning and returned
  no content. Three models did not answer within 90 s.
- **V4 SDK retries and timeout** (openai 7.28.0 source, `client.js`): `shouldRetry` retries
  408, 409, 429 and every status ≥ 500, plus connection errors and timeouts; 401/403 are not
  retried, unless the server sends `x-should-retry: true`, which the SDK obeys. Retries honour
  `retry-after-ms` / `Retry-After` up to 60 s, otherwise back off from 0.5 s to at most 8 s.
  `timeout` applies per HTTP attempt and covers the time until the response headers; a
  streaming body is not bounded by it. Contract tests: 401 and 403 → one request; 429 then a
  stream → two; persistent 503 → three; a response slower than a shortened timeout →
  `llm_timeout` after three requests. msw does not follow a mocked redirect, so
  `redirect: "error"` rests on the fetch specification rather than a test.

## Consequences

- A key is necessarily in process memory while its generation runs; a restart loses both, and
  the answer is retried with the key sent again. Clearing the holder drops this service's
  reference; the string itself (and the SDK client's copy) lives until garbage collection.
- `errorDetail` shows the upstream's own error message, scrubbed of credentials and cut to 500
  characters. An upstream may put other details there (for example parts of the request); the
  hosted providers probed do not.
- `NVIDIA_BASE_URL` also accepts `http://`, for a self-hosted endpoint on an internal network;
  keys then travel in cleartext on that network, which is the operator's choice.
- In the worst case the first token waits for three attempts of 60 s plus `Retry-After` pauses;
  JSON clients are still answered within their wait (202), and the generation deadline bounds
  the attempt.
- Upstream error formats differ by provider: the mapping relies on the status first and
  best-effort message matching for context overflow. An upstream (server-configured, so
  trusted) could force a retry of a 401 with `x-should-retry: true`.
- The SDK timeout ends when the headers arrive, so the adapter applies the same 60 s to every
  gap between chunks: a stream that stops sending fails with `llm_timeout`. The total time of
  an attempt is bounded by the generation deadline.
- Adding an OpenAI-compatible provider (for example a local model) means a catalog entry, a
  base URL setting and one line in `server.ts`, with no key for a keyless server.
- Ordinary error messages could in principle contain a key the serializer cannot recognise;
  the adapter therefore only ever throws already-scrubbed `LlmError`s, and other code never
  sees a key.

## Amendment (2026-10-22, issue #11): the local `ollama` provider

`ollama` reuses `OpenAiCompatibleProvider` with two different settings: `timeout` 120 s instead
of 60 s, and `maxRetries` 0 instead of 2 (`apps/server/src/llm/providers.ts`). A CPU model can
need over a minute before its first token, and every retry would evaluate the whole prompt again
inside the same 180 s generation deadline, so a retry would mostly turn an upstream error into a
later `llm_timeout`. The 120 s also applies to every gap between chunks. `nvidia` keeps 60 s and
two retries. Contract test: a 500 from the local model → one request, `llm_upstream_error`.

## Amendment (2026-10-22, issue #33): keyless providers never receive a key

The credential decision above took the `X-LLM-Api-Key` header first, whatever the provider, so
a turn on a keyless provider carried the caller's key to the adapter, which sent it upstream as
`Authorization: Bearer <key>` instead of `no-key`. Ollama ignores it, but a hosted-provider key
then reached a service with no use for it, and anyone controlling `OLLAMA_BASE_URL`'s host could
read it. Decided by the owner: the decision now starts with the provider. `requiresKey: false`
→ `null`, ignoring the header and any operator key; otherwise header → operator key → 422
`llm_credential_missing`, as before. The header is still validated by the route schema on every
provider (a malformed one is a 400 that is never echoed), and replays still skip the decision.
Tests: `decideCredential` unit cases, and an `ollama` send behind the msw upstream that records
`Authorization: Bearer no-key` with a header and with `OLLAMA_API_KEY` set.

## Amendment (2026-10-22, issue #36): nemotron-3-ultra, a reasoning model, with reasoning filtered out

Decided by the owner. This reverses the exclusion of reasoning models in V3 above and replaces
the catalog.

**Why.** `meta/llama-3.2-11b-vision-instruct` had been catalogued by elimination, and it was
unreliable: in a five-run benchmark it answered 3 of 5 times (the other two calls sent nothing
within 120 s), with a median of 21 s, and on a local trial stack one turn got no token for
177 s and failed `llm_timeout`. Every model the key's account could use was then probed; all
of them reason before answering, 12 others answered 404 and 2 timed out. The five usable ones
ran 20 times each in rotating order (a three-sentence answer, an explanation of at most 150
characters, and two-turn recall), streamed with `max_tokens` 4096, a 90 s timeout and no
retries:

| Model                                  | OK                                | First answer token p50 / p95 | Total p50 / p95 | Recall |
| -------------------------------------- | --------------------------------- | ---------------------------- | --------------- | ------ |
| nvidia/nemotron-3-ultra-550b-a55b      | 20/20                             | 2.0 / 10.6 s                 | 6.7 / 19.4 s    | 6/6    |
| nvidia/nemotron-3.5-lightning-30b-a3b  | 20/20                             | 12.3 / 22.2 s                | 13.1 / 23.1 s   | 5/6    |
| z-ai/glm-5.3-flash                     | 20/20                             | 14.5 / 85.5 s                | 19.3 / 86.9 s   | 6/6    |
| deepseek-ai/deepseek-v4.1-flash        | 20/20                             | 27.4 / 49.2 s                | 27.9 / 52.9 s   | 6/6    |
| nvidia/nemotron-3.5-super-vl-120b-a12b | 14/20 (3 × HTTP 500, 3 × timeout) | 7.6 / 44.9 s                 | 8.3 / 46.0 s    | 5/5    |

`nemotron-3-ultra` used about 166 output tokens per call (about 86 characters of reasoning and
131 of answer); no model ran out of output budget.

**Decision.**

- `nvidia/nemotron-3-ultra-550b-a55b` is the only `nvidia` model and its default, with a
  262,144-token context window and 4,096 output tokens (V1, V2 below). Text only.
- **Reasoning is filtered out.** The adapter reads only `choices[0].delta.content`; the
  reasoning side fields (`reasoning_content`, `reasoning`) are never read, so reasoning is never
  stored, returned, streamed, logged or sent as history. The API does not change: no new field
  and no new event. While the model reasons, an event stream shows only `message.created` and
  `: ping` comments, and a JSON client waits as usual. Showing reasoning is out of scope.
- **No request options.** The model card says reasoning is on by default ("Reasoning ON
  (default)", switched by `chat_template_kwargs.enable_thinking`), and the live probe below
  confirms that a request without `chat_template_kwargs` reasons and answers exactly like one
  with `enable_thinking: true`. The catalog therefore needs no per-model request options, and
  its schema is unchanged.
- **An answer without text fails.** A stream that finishes without any `content` text throws
  `llm_upstream_error`: "The model used its whole output budget before it started the answer."
  for finish reason `length`, otherwise "The model provider finished without any answer text."
  The existing code fits best: the other codes name a key, the input length or time, while
  here the upstream's answer is unusable. This holds for every OpenAI-compatible provider: an
  empty completed answer would otherwise be stored and sent as history in later turns.
- Answers may contain Markdown (for example `**bold**`); they are stored and returned as the
  model wrote them.

**Verification findings** (live probe in the `live-llm` workflow,
[run 39808368033](https://github.com/shaun0457/llm-chat-backend/actions/runs/39808368033),
and the sources named):

- **V1 context and output limits.** The model card gives a context of "up to 1M tokens", and its
  vLLM and SGLang recipes serve 262,144 tokens (256k) unless long context is enabled explicitly.
  The hosted API does not reveal its limit: its public `GET /v1/models` lists only id, object,
  created and owned_by, and a request with `max_tokens` 4,000,000 was accepted and answered
  normally (35 completion tokens), so the bound is not checked against a request. The catalog
  takes the documented default of 262,144; were the hosted deployment shorter, an overflow
  would fail as `llm_context_overflow`. A prompt that large was not sent: it would cost about
  a quarter of a million tokens per check.
- **V2 reasoning size.** Four prompts (one short sentence, at most 150 characters, three
  sentences, a short logic puzzle), each without options and with `enable_thinking: true`:
  31 to 299 completion tokens including 86 to 1,061 characters of reasoning, every call
  finishing with `stop`. With `enable_thinking: false` there was no reasoning (8 and 70 tokens).
  The two longest answers (260 and 299 tokens) streamed at about 64 and 52 tokens per second
  after their first chunk (shorter calls had pauses that make a rate meaningless), so 4,096
  tokens take roughly 65 to 80 s, inside the 180 s generation deadline, where 8,192 would not
  fit reliably. 4,096 is over 13 times the largest use seen here or in the benchmark.
- **V3 the reasoning field with the `openai` SDK.** openai 7.28.0 yields each chunk's parsed
  JSON unchanged (`core/streaming.js`), so fields the SDK's types do not declare survive.
  NVIDIA streamed the reasoning in `delta.reasoning_content` (a string) before the
  `delta.content` chunks in every call; `delta.reasoning` was not seen, but the contract tests
  cover both names. `stream_options.include_usage` reported usage in every call, and the
  completion tokens include the reasoning.
- **V4 timeouts.** First chunk after 0.4 to 3.5 s, once 20.5 s (a queued request); whole
  answers within 26.2 s; the benchmark's p95 was 10.6 s to the first answer token and 19.4 s in
  total. Reasoning chunks count as progress for the 60 s bound between chunks. The 60 s
  per-attempt timeout, the two retries and the 180 s generation deadline stay unchanged.

**Tests.** `test/adapters/openai-compatible.test.ts` ("contract.reasoning": reasoning in either
field never becomes text and keeps finish reason and usage; a budget that ends in reasoning, or
a stream without text, fails with `llm_upstream_error`).
`test/integration/messages-reasoning.test.ts`: for both field names, over JSON and SSE, the
stored and returned answer and the SSE deltas hold only the answer, the next turn's history
holds only the answer, no log line, response or database row contains reasoning, and a budget
used up by reasoning fails with `llm_upstream_error` and no content.
`test/adapters/nvidia-live.test.ts` and the `live-llm` workflow run against the new model with
1,024 output tokens (reasoning plus a short answer) instead of 32.
