# ADR 0006: Server-sent events, generation that outlives the connection, snapshot re-attach

- Status: accepted
- Date: 2026-10-22

## Context

A chat UI wants the answer token by token. The answer can take minutes, proxies close idle
connections, users close tabs, and networks drop. Whatever the client does, the answer must
still be generated and stored (ADR 0003, ADR 0005), and a client that comes back must be able
to see it, including a JSON client that got a 202 and now wants to watch the rest. One slow
reader must never make the server buffer without bound.

## Options considered

- **Transport.** WebSockets (bidirectional, but a second protocol, upgrade handling and no
  plain-HTTP semantics for errors); long polling (simple, but a request per chunk); **server-sent
  events** over a normal HTTP response (one-way, which is all an answer needs; curl and
  `EventSource` read it; errors before the stream are ordinary HTTP statuses).
- **Disconnect.** Cancel the generation when the client leaves (saves tokens, loses the answer)
  or **keep generating** (the answer is stored and can be read or followed later).
- **Reconnect.** `Last-Event-ID` with numbered events (needs an event log per message, kept
  somewhere, and a numbering that survives restarts) or a **snapshot**: on every attach, send
  the message as it is now, then only what comes after.

## Decision

SSE, generation independent of the connection, and snapshot re-attach.

- **Negotiation.** `POST /sessions/:id/messages` compares q-values. It streams only when
  `Accept` lists `text/event-stream` by name with a q above 0 and strictly above the q of
  `application/json`. JSON's q is that of its most specific matching range: `application/json`,
  then `application/*`, then `*/*`; 0 when none matches. Ranges that match the event stream
  only by wildcard (`text/*`, `*/*`) never select it, a range with a malformed q is ignored, and
  a tie or a missing or empty `Accept` answers JSON (ADR 0004). So `text/event-stream` streams;
  `application/json, text/event-stream;q=0.5` and `text/event-stream, */*` answer JSON. Every
  response of the route, including its problem responses and the stream, carries
  `Vary: Accept`. The header is set before validation and copied into the stream's head when
  the reply is hijacked. The rule is a small local parser rather than a dependency. Everything
  found before the stream starts (validation, 404, 409, 422, 503) is an ordinary problem
  response with its status. Once the stream started, the status is 200 and a generation
  failure is the `error` event. `GET /sessions/:id/messages/:mid/events` always streams; it
  re-attaches to the message's current attempt after running stale reclaim for the session,
  and is 404 `session_not_found`, or `message_not_found` for anything but an assistant message
  of that session.
- **Events.** `event: <name>` plus one `data:` line of JSON, no `id:` lines:
  `message.created { userMessage, assistantMessage }`, `delta { id, attempt, text }`,
  `done { assistantMessage }`, `error { code, detail, assistantMessage }`,
  `message.detached { assistantMessage }`. A `: ping` comment every `SSE_PING_INTERVAL_MS`
  (15 s). After `done`, `error` or `message.detached` the server ends the response.
- **`message.created` is the snapshot**, for sends and re-attachments alike: the messages as
  they are at that moment. Because the job starts before the stream attaches, its content may
  already be non-empty, and on a re-attach the message may already be terminal.
- **No gap, no duplicate.** With a local job for the attempt, `attach()` reads the job bus's
  text and subscribes in one synchronous step, so every later `delta` is new text only.
  Without one, it reads the row: terminal → `message.created` and `done`/`error`; still
  generating (another process, or a lost generation that reclaim has not failed yet) →
  `message.created` and `message.detached`, and the client polls. If a followed job ends
  without publishing a final state (its turn was deleted, or the final write failed), the row
  is read once more: terminal → `done`/`error`, generating → `message.detached`, gone → the
  stream ends without a final event.
- **Headers and hijack.** After admission, the headers already set on the reply by hooks (the
  request id now, CORS and security headers later) are copied, `Content-Type:
text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`,
  `X-Accel-Buffering: no` and `Connection: keep-alive` are added, the reply is hijacked and
  the head written on the raw response. No compression is registered for these routes.
- **Disconnect** (socket close or write error) only unsubscribes and stops the ping. The job is
  never aborted by a client. A JSON send whose client leaves stops waiting at once; its
  generation goes on too.
- **Slow consumers.** Before any frame (snapshot, delta, final event, ping) is written, the
  response's pending bytes plus the frame's UTF-8 length are compared with
  `SSE_BUFFER_LIMIT_BYTES` (256 KiB). While bytes are still waiting, a frame that would exceed
  it is not written: that connection is destroyed and unsubscribed. A frame written to an empty
  buffer always goes out, however large, so one big `message.created` or `done` never counts
  as a slow client, even at the 16 KiB minimum. Every subscriber is checked on its own, and the
  generation is never touched.

## Verification findings

- **V1 hijack.** Kept: headers set by earlier hooks are readable with `reply.getHeaders()`
  before `reply.hijack()` (the request id arrives on the SSE response over a real socket), and
  Fastify sends nothing of its own afterwards: the request is logged exactly once as `request
completed` with status 200 when the stream ends (integration test `messages-sse` ›
  "is logged as a completed request, with its request id (V1)"). An async handler may return
  the reply after hijacking; Fastify then does nothing more.
- **V2 inject().** Holds: `inject()` resolves with the whole streamed body once the stream ends,
  so terminal, detached, reclaimed and 404 cases use it (`messages-events` › `events.terminal`,
  `events.fallback`). Live delivery, pings, disconnects and the slow consumer use a real
  listening socket (`test/helpers/sse-client.ts`).
- **V3 `writableLength`.** Reliable on Node 22: with a client that stopped reading, the
  response's `writableLength` matched the bytes written minus the bytes whose write callback
  had fired, within the chunked-encoding framing (a few bytes per chunk), at every step up to
  24 MiB; it is the socket's own `writableLength` plus what the response holds itself. On the
  Windows development machine the operating system absorbed only about 320 KiB before Node
  started buffering; on Linux the socket buffers can take a few MiB. The limit therefore
  bounds what the process holds per connection, not what the kernel holds, and the
  slow-consumer test sends 16 MiB so that either way the limit is reached
  (`messages-sse` › `sse.slow-consumer`).

## Consequences

- One code path for both: a client renders `message.created`, appends deltas, and replaces
  the message with the final event's. A reconnect re-receives the full text so far (by design);
  there is no `Last-Event-ID`.
- A stream is followed live only in the process that runs the job. Another process (a brief
  deploy overlap) answers `message.detached`, and the client falls back to polling.
- A user who closes the tab still pays for the answer, which is stored. Stopping a generation
  on purpose is session deletion (#12) for now. A delete aborts the session's jobs as soon as it
  commits, so the streams following them end at once, without a final event (no new event
  type or error code); re-attaching afterwards answers 404.
- The buffer limit applies while the stream is open. Once the server ends a stream, Node
  hands the rest to the socket and reports the response finished; a client that never reads
  that rest holds at most the limit's worth of data until the server's keep-alive timeout
  (Fastify's default, 72 s) closes its idle socket. A local probe confirmed the socket closes
  shortly after that timeout.
- Hijacked responses bypass `onSend` hooks: whatever later plugins add there does not reach
  SSE responses unless it sets its headers earlier (in `onRequest`, as the request id does).
- Some proxies buffer despite these headers; JSON with polling remains the fallback. The
  service is not deployed (#14 was closed), so live delivery through a platform proxy is
  unverified (#25).
- Replays (#10) and retries (#13) reuse `attach()` for both modes.
