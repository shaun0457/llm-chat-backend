# ADR 0007: Idempotent sends through client-supplied message ids

- Status: accepted
- Date: 2026-10-22

## Context

A send can take minutes, and clients time out, lose connections and retry. A client that gave
up cannot tell whether its message was stored. Sending it again must not create a second turn
(the user sees the question twice and pays for two answers), nor fail with 409 `session_busy`
because the first copy is still being generated, nor fail for reasons unrelated to the
original request: a key the client no longer sends, session defaults changed since, or a full
server. The rule has to hold across a restart and a brief deploy overlap, so it cannot live in
memory (ADR 0003).

## Options considered

- **A generic `Idempotency-Key` header with a stored-response table**: works for any endpoint,
  but needs a table, a retention policy for it, a request fingerprint, and a decision about
  what to store for a response that is still being generated. A chat turn already has a
  natural identity.
- **Deduplicate by content** (same text within a time window): needs no client cooperation,
  but silently swallows a user who really asks the same question twice, and the window is
  arbitrary.
- **Let the client choose the user message's id**: the message row itself is the idempotency
  record. The primary key makes "admitted at most once" a database rule, and the stored turn
  is the response, in whatever state it is now.

## Decision

The client may send `id` (any UUID version; otherwise 400) for the user message. Without it the
server generates a UUIDv7, and identical sends are not deduplicated.

- **Replay is step 3 of admission**, after the session row lock and stale reclaim, before every
  other check. If a message with that id exists, it must be a user message of this session
  with byte-identical content, and each of `provider` and `model` that the request names must
  equal the value frozen on the turn's assistant message (omitted ones are not compared, and
  the session's current defaults are never consulted). Then the request is a replay;
  otherwise it is 422 `message_id_conflict`, with a `detail` naming the failed condition and
  never the stored content.
- **A replay skips everything else**: pair resolution, catalog, budget, credential, busy
  check, capacity reservation, and every write. The transaction commits only what reclaim
  changed. The session's `last_activity_at` stays as it was.
- **The response goes through `attach()`** (ADR 0006) with the turn's current attempt and the
  request's mode: JSON waits under the usual `Prefer` rules (ADR 0004) and answers 200, 502 or
  202 by the turn's state, never "created"; an event stream sends the snapshot, then the live
  deltas when this process runs the job, or `done`/`error` (or `message.detached`) from the row.
  So a replay of a finished turn looks exactly like a re-attach to it.
- **Concurrent first sends.** Within one session the row lock serialises them: the second sees
  the first's committed rows and replays. Across sessions nothing is locked in common: the
  second insert hits the primary key (`messages_pkey`), or `messages_reply_to_id_unique` if
  the assistant row of the turn happens to be checked first. That transaction rolls back, its
  capacity reservation is released, and admission runs again from the start; the re-run sees
  the committed row and answers 422. After two re-runs that still collide the request fails as
  500 `internal_error` (logged) rather than loop.

## Verification

- The primary-key path is exercised deterministically: a test holds open a transaction that has
  inserted the id into another session, the send's replay check cannot see it, its insert
  waits on the key, and after the commit the send answers 422 with no rows written and its
  reservation released (`messages-replay` › `replay.race`). With the re-run disabled the same
  test gets a 500, so it does test the re-run.
- The bound is exercised with a trigger that fails every insert of one id as a unique
  violation on either constraint: the send runs admission three times (counted by the
  trigger), answers 500 `internal_error`, writes nothing and releases its reservation.
- Constraint name: the primary key of `messages` is PostgreSQL's default `messages_pkey`
  (migration `0001_create_messages.sql` declares it inline without a name), confirmed by that
  test.

## Consequences

- The guarantee is "never admitted twice", not "the model ran once": a failed answer was still
  a call to the model.
- Ids are global: a client cannot reuse an id across sessions, and an id taken by another
  session reveals that it is taken. Sessions are readable by anyone anyway (there is no
  authentication; see the README's "What I would do next"), so this discloses nothing new.
  Once sessions have owners, the conflict details that tell "another session" and "an
  assistant message" apart should become one generic detail.
- Provider and model are compared field by field with the stored turn, not resolved again:
  a request naming only the provider the turn used replays it even if that provider's default
  model differs from the turn's model. A replay never re-reads session defaults.
- The id is a UUID, so case does not matter (PostgreSQL compares `uuid` values); responses
  show it in lower case. The nil and max UUIDs are rejected (400), so a placeholder value
  cannot be taken by its first user.
- Content is compared exactly: a client that re-normalises text (a trailing newline, Unicode
  normalisation) gets 422 instead of a replay.
- A replay of a turn that a crash left `generating` past the stale threshold is reclaimed first
  (its row becomes failed / `interrupted` in the same transaction) and answers 502 or `error`.
  Before that threshold no process follows it: JSON answers 202 and an event stream
  `message.detached`, as for a re-attach.
- No idempotency table, no retention for it: deleting a session deletes its ids with it, and
  the id can then be used again.
- The retry extra (#13) would reuse the same shape: a retry carrying `expectedAttempt` replays
  the current attempt when it is `expected + 1`, again detected first under the session lock.
