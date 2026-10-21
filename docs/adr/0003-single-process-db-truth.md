# ADR 0003: One API process, the database as the only shared truth

- Status: accepted
- Date: 2026-10-22

## Context

Sending a message starts a generation that can take from a second to minutes. Several rules
must hold no matter how requests interleave: a session has at most one turn generating, a
retry never lets an older attempt overwrite a newer one, partial text survives a crash, and a
deleted turn stays deleted. The service must be easy to run (one container plus PostgreSQL)
and still be correct during a deploy that briefly overlaps two processes.

## Options considered

- **In-memory coordination** (a per-session mutex, a map of running turns): simple and fast,
  but correct only while exactly one process exists; a deploy overlap or a restart silently
  breaks every rule.
- **A job queue with workers** (a jobs table with `SKIP LOCKED`, pg-boss, or Redis/BullMQ),
  leases and heartbeats: scales out, but adds a second moving part, lease tuning, a sweeper,
  and a hand-off between the HTTP request and the worker that streams to it.
- **One process, with every rule enforced by PostgreSQL**: generations run in the API process;
  memory only holds what is lost harmlessly on restart (the stream buffer, the abort
  controller, capacity counters), while row locks, unique constraints and conditional updates
  decide every outcome.

## Decision

One API process runs the HTTP server and the generations. The database is the only shared
truth:

- **Admission** is one transaction: `SELECT … FROM sessions WHERE id = $1 FOR UPDATE`, then
  "is a turn generating?", then insert the user row (`completed`) and the assistant row
  (`generating`, `attempt = 1`, `started_at = clock_timestamp()`, frozen provider, model and
  system prompt), advance `next_seq`, bump `last_activity_at`, derive the title if the session
  has none, commit. The lock serialises sends to one session; sends to different sessions do
  not wait for each other. The service is an ordered list of named steps so that later rules
  (stale reclaim, replay, budget, credential, expected history, capacity) slot in between.
- **One generating turn per session** is the partial unique index
  `messages_one_generating_per_session ON messages (session_id) WHERE status = 'generating'`.
  The lock makes the busy check the normal path (409 `session_busy`); a unique violation on
  that index, which only a second process could cause, maps to the same 409.
- **Fenced writes.** Every write a generation makes, the partial-content flushes and the
  terminal update alike, carries the same predicate:

  ```sql
  UPDATE messages SET … WHERE id = $1 AND attempt = $2 AND status = 'generating'
  ```

  A write that matches no row means the turn was deleted or superseded: the job aborts its
  provider call and writes nothing more.

- **Jobs are process-local.** A job (assistant id, attempt, frozen settings, abort controller,
  event bus, capacity reservation) lives in a map keyed by assistant id and is started only
  after the admitting transaction commits. Its `finally` always releases the reservation
  exactly once, removes the map entry only if the map still holds this job, and closes the
  bus. The bus keeps the text so far and its subscribers; publishing never awaits a
  subscriber and a subscriber that throws is skipped.
- Partial content is flushed every `FLUSH_INTERVAL_MS` (default 1 s) when it changed, so a
  reader polling `GET /sessions/:id/messages/:mid` sees progress and a crash loses at most one
  interval of text.

## Verification findings

- **V1 partial index and checks in the Drizzle schema:** yes. `uniqueIndex(…).on(…).where(sql…)`
  and `check(…)` in `src/db/schema.ts` generate `CREATE UNIQUE INDEX … WHERE …` and
  `CONSTRAINT … CHECK (…)` in `drizzle/0001_create_messages.sql`; regenerating reports no
  changes and `drizzle-kit check` passes, so the CI drift check needs no exclusions.
- **V2 constraint name through Drizzle:** yes. Drizzle 0.45 wraps the driver error in its own
  error with the `pg` error as `cause`; the cause carries SQLSTATE `23505` and
  `constraint: "messages_one_generating_per_session"`. `pgConstraint()` reads it along the cause
  chain like `pgErrorCode()` (integration test `messages-schema`).

## Consequences

- Correct under a deploy overlap: the old process's late writes are fenced out, and two
  processes can never admit two turns for one session. The worst effect is an interrupted
  generation.
- Capacity limits, the abort fast path and live streams are per process. A turn generating in
  another process can be polled but not followed live.
- Until deadlines and stale reclaim exist, a process that stops mid-generation leaves its row
  `generating`, which keeps that session busy. Shutdown aborts every job and lets waiting JSON
  requests answer before the server closes.
- Each generation issues one small `UPDATE` per flush interval while text arrives.

## Multi-instance upgrade path (documented, not built)

1. Shared capacity: per-provider and global counters in PostgreSQL (or Redis) instead of
   process memory.
2. Ownership: a lease column (`owner`, `lease_until`) renewed by a heartbeat, so another
   instance can take over or fail a turn whose owner died; fencing by `attempt` already makes
   the takeover safe.
3. Work distribution: a jobs table claimed with `FOR UPDATE SKIP LOCKED` (or a queue) so
   generations run on worker processes, separate from HTTP.
4. Live streams across instances: publish deltas over `LISTEN/NOTIFY` or Redis pub/sub, so a
   client can re-attach on any instance.
