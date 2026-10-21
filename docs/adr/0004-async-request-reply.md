# ADR 0004: Asynchronous request-reply for JSON sends, steered by RFC 7240 `Prefer`

- Status: accepted
- Date: 2026-10-22

## Context

A JSON send used to wait until the answer was finished. A CPU-only local model or a slow
upstream can take minutes, while reverse proxies and HTTP clients typically give up after
30–120 seconds. A client cut off by a proxy learns nothing, not even the ids of the messages it
created, although the generation goes on. Waiting longer only moves the timeout; streaming
(SSE) helps browsers but not simple scripts.

## Options considered

- **Always wait** (the previous behaviour): one round trip, but unbounded; the proxy decides
  the outcome.
- **Always answer at once** (202 + poll): bounded, but every quick answer costs at least two
  round trips, and simple clients must implement polling even for the demo provider.
- **A custom wait parameter** (`?wait=`, `X-Wait`): works, but invents vocabulary that HTTP
  already has.
- **Wait a bounded time, chosen with the standard `Prefer` header** (RFC 7240 `wait` and
  `respond-async`), then 202 with a poll target: quick answers stay one round trip, slow ones
  become asynchronous, and the client chooses with a standard header.

## Decision

The last option.

- `effectiveWait = respond-async ? 0 : min(requested wait ?? JSON_DEFAULT_WAIT_MS,
JSON_MAX_WAIT_MS)`, with defaults of 30 s and 195 s. Startup rejects a default above the
  maximum, and both settings are at most 600 s (well below the `setTimeout` limit).
- **Parsing follows RFC 7240 §2.** All `Prefer` lines are joined by commas; each preference is
  `token [= word]` with `;` parameters, which are ignored. Names are case-insensitive, quoted
  values are accepted, and commas or semicolons inside quotes do not split. Only the first
  occurrence of a preference counts, even when its value is invalid (so `wait=abc, wait=5`
  waits the default). `wait` must be a non-negative integer number of seconds. Anything else
  is ignored: preferences are advisory, so they never cause a 400.
- **Waiting** races the job's end (its `finished` promise) against one timer; the timer is
  cleared on every path, and there is no polling loop. Afterwards the rows are read once, so
  the response always reports the stored state. Without a local job for that attempt nothing
  is waited for.
- **Outcomes:** completed → 200 `{ userMessage, assistantMessage }`; failed → 502 problem
  details with both messages; still generating → 202 with both messages, `Location:
/sessions/:id/messages/:assistantId` (a relative reference, as RFC 9110 §10.2.2 allows),
  `Retry-After: 2` and `Cache-Control: no-store`. Generation continues in every case.
  `respond-async` means "no additional waiting", not "always 202": a turn already known to be
  terminal is still 200 or 502.
- **`Preference-Applied`** lists only what changed the behaviour: `respond-async` when it was
  honoured, otherwise `wait=<seconds>` when a valid `wait` was sent, showing the wait actually
  used (the cap, in whole seconds rounded down, when the request asked for more). No header
  when neither applies. It is not a completion guarantee.
- **The poll target** `GET /sessions/:id/messages/:mid` always answers with `Cache-Control:
no-store` (also on its 404), so no cache serves an old state of an answer that is still
  changing.

## Verification findings

- **V1 `Location` on a 202:** kept as set. Fastify passes the header through unchanged,
  including over a real socket (integration test `messages-prefer` › "keeps Location as the
  relative message path over a real socket"), and RFC 9110 §10.2.2 allows a relative
  reference, resolved against the request URI. No `PUBLIC_BASE_URL` is needed.

## Consequences

- Clients must always handle 202, even with a long `wait`: the server may shut down during the
  wait, and the platform proxy may still be shorter than the configured maximum (the
  deployment lowers `JSON_MAX_WAIT_MS` below its proxy timeout).
- Waiting is cheap: a waiting request holds no database connection, only a timer and a
  promise.
- A turn that is generating in another process (or whose process died) is reported as
  generating until stale reclaim fails it; polling shows that state honestly.
- When the job could not store its final state, the send still answers 500 `internal_error`
  as before; once stale reclaim exists that row becomes `interrupted` and a 202 is the honest
  answer.
- Retries and replays reuse the same parser and wait rule.
