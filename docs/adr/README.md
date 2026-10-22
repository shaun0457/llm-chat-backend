# Architecture decision records

Each record states the context, the options considered, the decision, what was verified and the
consequences. All are accepted; later changes are added as dated amendments at the end of a
record rather than in a new one.

| ADR                                         | Status                                 | Decision in one line                                                                                                                                          |
| ------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0001](0001-stack-and-tooling.md)           | accepted                               | Fastify 5 with zod route schemas drive validation, types and the OpenAPI document; RFC 9457 errors, pino JSON logs, exactly pinned versions                   |
| [0002](0002-postgres-drizzle-migrations.md) | accepted                               | PostgreSQL 17 with Drizzle; committed SQL migrations run by a separate one-shot step under an advisory lock, never by the API; readiness checks them          |
| [0003](0003-single-process-db-truth.md)     | accepted                               | One API process; the database is the only shared truth: a row lock per send, a partial unique index for one generating turn, fenced writes per attempt        |
| [0004](0004-async-request-reply.md)         | accepted                               | A JSON send waits a bounded time chosen with RFC 7240 `Prefer`, then answers 200, 502 or 202 with `Location` to poll                                          |
| [0005](0005-deadline-reclaim.md)            | accepted                               | A hard deadline per attempt and a bounded final write let the next request to its session fail a dead `generating` row as `interrupted`; no leases or sweeper |
| [0006](0006-sse-reattach.md)                | accepted                               | Server-sent events with q-value negotiation; generation outlives the connection, and re-attaching gets a snapshot then live deltas                            |
| [0007](0007-idempotency-client-ids.md)      | accepted                               | A client-supplied user-message id makes a send safe to repeat: the same send replays the stored turn, any other use of the id is 422                          |
| [0008](0008-llm-port-byok.md)               | accepted; amended for #11, #33 and #36 | One provider port and an OpenAI-compatible adapter (SDK, client per call); the caller's key lives in memory for one generation and is never stored or logged  |
