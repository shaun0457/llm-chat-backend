# LLM Chat Backend

A multi-session chat API in front of large language models, built with Fastify, TypeScript and
PostgreSQL. Based on [nhwang0/llm-chat-backend](https://github.com/nhwang0/llm-chat-backend)
at [`8bf820d`](https://github.com/nhwang0/llm-chat-backend/tree/8bf820d).

**Scope.** This goes beyond a typical 4–6 hour take-home: slow answers, client retries and
users' own API keys make a naive chat backend lose answers, duplicate turns or leak keys, so
every consistency rule here is enforced by PostgreSQL and proven by tests against a real
database. The work lands as small test-first tickets, core requirements first, so the
repository runs and is documented at every step; what is not built yet is listed under
[What I would do next](#what-i-would-do-next).

| Assignment item (paraphrased)                                   | README section                                                               |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Manage many chat sessions: create, list, read, update, delete   | [Query support](#query-support)                                              |
| Send a message, get the model's answer, keep the history        | [Sending a message](#sending-a-message), [Database schema](#database-schema) |
| Cope with answers that take a long time                         | [Long-running answers](#long-running-answers-json-clients)                   |
| Talk to a real LLM provider, with the user's own API key        | [Providers and API keys](#providers-and-api-keys)                            |
| Start everything with one command                               | [Run with Docker](#run-with-docker)                                          |
| An architecture diagram                                         | [Architecture](#architecture)                                                |
| The database schema                                             | [Database schema](#database-schema)                                          |
| What the API can query                                          | [Query support](#query-support)                                              |
| How to run the tests, and how the code is tested                | [Test](#test), [Testing approach](#testing-approach)                         |
| Two or three build-versus-reuse decisions with their trade-offs | [Build vs reuse](#build-vs-reuse)                                            |
| Where the API documentation is                                  | [API documentation](#api-documentation)                                      |
| Why it was built this way                                       | [`docs/adr`](docs/adr)                                                       |
| Bonus items: streaming, a local model, a public deployment      | Not built yet, see [What I would do next](#what-i-would-do-next)             |

## Prerequisites

- Docker (Compose v2), for the one-command stack and the integration tests
- Node.js 22 (the image uses 22.23.3) and pnpm 9 (`corepack enable`), to develop and test

## Run with Docker

```sh
docker compose up --build    # http://localhost:3000
```

This starts PostgreSQL 17, waits until it is healthy, runs the migrations once (`migrate`
exits 0), and only then starts the API. The defaults need no `.env`; copy `.env.example` to
`.env` to change the database credentials, the host port (`API_PORT`) or the server settings.
PostgreSQL is not published to the host. `docker compose down -v` removes the data volume.

Check it with a hosted model. Enable it in `.env` with `PROVIDERS_ENABLED=demo,nvidia`, and
either set the server's key there (`NVIDIA_API_KEY=...`) or bring your own key per request in
the `X-LLM-Api-Key` header (see [Providers and API keys](#providers-and-api-keys)):

```sh
curl localhost:3000/health/ready
curl -X POST localhost:3000/sessions -H 'content-type: application/json' \
  -d '{"title":"Hello","provider":"nvidia"}'
curl localhost:3000/sessions
# with NVIDIA_API_KEY set on the server:
curl -X POST localhost:3000/sessions/<id>/messages -H 'content-type: application/json' \
  -d '{"content":"Hello"}'
# or with your own key, used for this one answer and never stored:
curl -X POST localhost:3000/sessions/<id>/messages -H 'content-type: application/json' \
  -H "X-LLM-Api-Key: $MY_NVIDIA_KEY" -d '{"content":"Hello"}'
```

Without any key, create the session without `provider`: the built-in demo provider answers at
once with a fixed sentence.

## Run locally

Point `DATABASE_URL` at a PostgreSQL 17 database, for example a throwaway container:

```sh
docker run -d --name chat-db -e POSTGRES_PASSWORD=chat -p 127.0.0.1:5432:5432 postgres:17.11-alpine
export DATABASE_URL=postgres://postgres:chat@localhost:5432/postgres

pnpm install
pnpm build
pnpm --filter server migrate   # applies drizzle/*.sql; the API itself never migrates
pnpm start                     # http://localhost:3000
```

`pnpm dev` rebuilds on change. Logs are JSON; for readable output pipe them through the bundled
formatter: `pnpm --filter server start | pnpm --filter server exec pino-pretty`.

## Configuration

Environment variables, validated at startup. An invalid value stops the process and names the
variable, never its value. Blank values count as unset. `JSON_DEFAULT_WAIT_MS` must not
exceed `JSON_MAX_WAIT_MS`. The four timing keys of [failure handling](#failure-handling) must
be positive whole numbers of milliseconds, at most one hour.

| Variable                        | Default                      | Meaning                                                                                                         |
| ------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                  | (required)                   | `postgres://` or `postgresql://` connection URL                                                                 |
| `PORT`                          | `3000`                       | Listening port                                                                                                  |
| `HOST`                          | `0.0.0.0`                    | Listening address                                                                                               |
| `LOG_LEVEL`                     | `info`                       | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`                                                  |
| `NODE_ENV`                      | `production`                 | `development`, `test` or `production`                                                                           |
| `MODEL_CATALOG_PATH`            | bundled `config/models.json` | Model catalog file (see below)                                                                                  |
| `PROVIDERS_ENABLED`             | `demo`                       | Comma-separated provider ids; each must be in the catalog                                                       |
| `DEFAULT_PROVIDER`              | `demo`                       | Provider for sessions created without one; must be enabled                                                      |
| `DEFAULT_MODEL`                 | the provider's default       | Model for sessions created with neither provider nor model; must be in the catalog                              |
| `DEFAULT_SYSTEM_PROMPT`         | (none)                       | System prompt for turns of sessions without their own (up to 8,000 characters)                                  |
| `FLUSH_INTERVAL_MS`             | `1000`                       | How often a generating answer's partial text is written to the database (10–60,000)                             |
| `DEMO_DELAY_MS`                 | `50`                         | Pause between the demo provider's chunks (0–10,000)                                                             |
| `JSON_DEFAULT_WAIT_MS`          | `30000`                      | How long a JSON send waits for its answer without `Prefer: wait` (0–600,000)                                    |
| `JSON_MAX_WAIT_MS`              | `195000`                     | The longest a JSON send ever waits (0–600,000); keep it below your proxy's timeout                              |
| `GENERATION_DEADLINE_MS`        | `180000`                     | Hard limit of one generation attempt, from admission; then it fails as `llm_timeout`                            |
| `TERMINAL_STATEMENT_TIMEOUT_MS` | `3000`                       | Limit of each statement that stores an answer's final state                                                     |
| `TERMINAL_WRITE_BUDGET_MS`      | `10000`                      | Limit of storing the final state, retries included; also bounds graceful shutdown                               |
| `RECLAIM_GRACE_MS`              | `50000`                      | Margin before a generating row with no live job counts as dead; ≥ statement timeout + 1 s                       |
| `MAX_ACTIVE_GENERATIONS`        | `8`                          | Active answers in this process at most; then 503 `server_busy` (1–10,000)                                       |
| `MAX_ACTIVE_PER_PROVIDER`       | `4`                          | Active answers per provider unless its catalog entry sets `maxConcurrency`; then 503 `provider_busy` (1–10,000) |
| `NVIDIA_BASE_URL`               | NVIDIA's public endpoint     | The `nvidia` provider's OpenAI-compatible API (`http`/`https`); clients can never choose a URL                  |
| `<PROVIDER>_API_KEY`            | (none)                       | The server's own key for an enabled provider, e.g. `NVIDIA_API_KEY` (1–512 visible ASCII)                       |

The model catalog lists, per provider, whether it needs an API key, its default model, its
models with context window and maximum output tokens, and optionally `maxConcurrency` (its
own active-answer limit instead of `MAX_ACTIVE_PER_PROVIDER`). Unknown fields are rejected, so provider
base URLs can only come from server configuration. A malformed catalog stops startup and names
the file and the offending entry (for example `providers.demo.models.0.contextWindow`).

```json
{
  "providers": {
    "demo": {
      "defaultModel": "demo",
      "requiresKey": false,
      "models": [
        { "id": "demo", "contextWindow": 8192, "maxOutputTokens": 1024 }
      ]
    }
  }
}
```

## Database schema

Migrations are generated from `apps/server/src/db/schema.ts` into `apps/server/drizzle/` by
`pnpm --filter server db:generate`, committed, and applied by the `migrate` entry under a
PostgreSQL advisory lock, so two runners never apply a migration twice.

`sessions`

| Column             | Type          | Notes                                                            |
| ------------------ | ------------- | ---------------------------------------------------------------- |
| `id`               | `uuid` PK     | UUIDv7, generated by the app                                     |
| `title`            | `text` null   | 1–200 characters                                                 |
| `provider`         | `text`        | Enabled provider id                                              |
| `model`            | `text`        | Model in that provider's catalog                                 |
| `system_prompt`    | `text` null   | 1–8,000 characters                                               |
| `next_seq`         | `integer`     | Next message sequence number; internal, never returned           |
| `last_activity_at` | `timestamptz` | Set at creation, moved only by new turns                         |
| `created_at`       | `timestamptz` | Same value as `last_activity_at` at creation                     |
| `updated_at`       | `timestamptz` | Moves on every settings change and when a send derives the title |

Index `(last_activity_at DESC, id DESC)` serves the session list.

`messages`

| Column                               | Type                | Notes                                                                                                    |
| ------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------- |
| `id`                                 | `uuid` PK           | UUIDv7, generated by the app                                                                             |
| `session_id`                         | `uuid` FK           | `sessions(id)`, `ON DELETE CASCADE`                                                                      |
| `seq`                                | `integer`           | Position in the session, unique per session; the only ordering key                                       |
| `role`                               | `text`              | `user` or `assistant`                                                                                    |
| `reply_to_id`                        | `uuid` null, unique | Assistant rows: the user message they answer (FK `messages(id)`)                                         |
| `content`                            | `text`              | Partial while generating; kept when the answer failed                                                    |
| `status`                             | `text`              | User rows: `completed`. Assistant rows: `generating`, `completed` or `failed`                            |
| `error_code`, `error_detail`         | `text` null         | Failed answers: a stable code and a safe description                                                     |
| `attempt`                            | `integer`           | Assistant rows: fencing token, 1 for the first answer. Stored as 1 on user rows, never returned for them |
| `started_at`                         | `timestamptz` null  | Assistant rows: when the attempt started (`clock_timestamp()`)                                           |
| `provider`, `model`, `system_prompt` | `text` null         | Assistant rows: the settings frozen when the turn was admitted                                           |
| `prompt_tokens`, `completion_tokens` | `integer` null      | Usage reported by the provider, if any                                                                   |
| `finish_reason`                      | `text` null         | `stop`, `length` or `other`                                                                              |
| `latency_ms`                         | `integer` null      | Admission to completion                                                                                  |
| `created_at`, `updated_at`           | `timestamptz`       | `updated_at` moves with every flush and the terminal write                                               |

- Unique `(session_id, seq)`, which also serves the backwards message list.
- Partial unique index `(session_id) WHERE status = 'generating'`: at most one turn generating
  per session.
- Check constraints keep user rows `completed` with every assistant-only column null, and
  require assistant rows to carry `reply_to_id`, `started_at`, `provider` and `model`.

## Query support

| Endpoint                          | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /sessions`                  | 201 + `Location`. Provider/model default to the configuration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /sessions`                   | `?limit=` 1–100 (default 20), `?cursor=` from the previous `nextCursor`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /sessions/:id`               | 404 `session_not_found` if missing, 400 for a malformed id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PATCH /sessions/:id`             | Any of `title`, `provider`, `model`, `systemPrompt`; `null` clears title or prompt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `DELETE /sessions/:id`            | 204, then 404                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /sessions/:id/messages`     | `{ "content", "provider"?, "model"? }` (content 1–16,000 characters, not blank; unknown fields are a 400). `provider`/`model` override the session's pair for this turn only. Waits a bounded time (see below): 200 `{ userMessage, assistantMessage }`, 502 problem details with both messages when it failed (`code` is the answer's `errorCode`), 202 with both messages while it is still generating. 422 `provider_unavailable` / `model_not_supported` for a pair that does not resolve, 422 `input_too_long` when the message cannot fit the model (see [Limits](#limits)), 409 `session_busy` while the session's previous answer is generating, 503 `server_busy` / `provider_busy` with `Retry-After: 10` at a capacity limit or while the server shuts down |
| `GET /sessions/:id/messages`      | `?limit=` 1–200 (default 50), `?before=` a message id of this session; newest page first, ascending `seq` within a page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /sessions/:id/messages/:mid` | One message, including the partial text of an answer being generated; `Cache-Control: no-store`; 404 `message_not_found` outside this session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /providers`                  | Enabled providers, whether they need a key, their catalogued models                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /health`                     | Liveness, no dependencies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /health/ready`               | 200 when the database answers and its migrations match this build                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

A message list page holds the newest `limit` messages below `before` (or the newest overall),
in ascending `seq`. `nextBefore` is the id of the page's first item when older messages exist,
otherwise `null`; pass it as `before` for the next page. A `before` that is not a message of
this session is 404 `message_not_found`.

Provider and model resolve by one rule on session create, on update and for a message's
override: both given → as given; provider only → that provider's default model, **also when
it is already the current provider**; model only → the current (or default) provider;
neither → the current (or configured default) pair. To keep the current model, omit
`provider`. An unknown or disabled provider is 422 `provider_unavailable`; a model outside
that provider's catalog is 422 `model_not_supported`. A message's override is frozen on its
assistant message and never changes the session.

The session list is ordered by most recent activity, then id, and pages with an opaque keyset
cursor. It is a **live list, not a snapshot**: a session that gets new activity while you page
moves to the first page, so clients refresh from the first page. Pages have no gaps or
duplicates while the ordering keys do not change. Timestamps are ISO-8601 UTC with microsecond
precision, the database's own precision.

## Architecture

### Components

```mermaid
flowchart LR
  client(["API client"])
  nvidia["NVIDIA hosted API<br/>OpenAI-compatible, HTTPS"]

  subgraph compose["docker compose"]
    migrate["migrate<br/>one-shot: dist/migrate.js"]
    postgres[("postgres<br/>PostgreSQL 17")]
    subgraph api["api: dist/index.js, one process built by buildApp()"]
      routes["Fastify routes<br/>health · providers · sessions · messages<br/>zod schemas: validation and /openapi.json"]
      services["sessions service<br/>messages service: admission transaction<br/>stale reclaim on every session-scoped request"]
      jobs["JobRegistry<br/>in-process jobs, one MessageBus each<br/>generation deadline, terminal-write budget<br/>process and provider capacity counters"]
      registry["ProviderRegistry<br/>ModelCatalog: config/models.json"]
      port{{"LlmProvider port"}}
      demo["DemoProvider<br/>no key"]
      openai["OpenAiCompatibleProvider<br/>openai SDK, a client per call"]
    end
  end

  client -- "HTTP, JSON" --> routes
  routes --> services
  services --> jobs
  services --> registry
  registry --> port
  jobs -- "stream(request, key)" --> port
  port --- demo
  port --- openai
  openai -- "the turn's key, server-defined base URL" --> nvidia
  migrate -- "advisory lock, Drizzle migrations" --> postgres
  services -- "row lock, reclaim, inserts, reads" --> postgres
  jobs -- "fenced UPDATEs" --> postgres
```

`docker compose up` starts `postgres`, runs `migrate` once (it exits 0 after applying the
migrations under an advisory lock) and only then starts `api`, which never migrates. `api` is a
single Node process: Fastify routes validate requests with zod, the services run each send as
one admission transaction, and every generation runs as a job inside the same process. Jobs
reach models only through the `LlmProvider` port; the `ProviderRegistry` maps the enabled
provider ids from the model catalog to their adapters. `demo` answers in process without a
key, and `nvidia` goes through `OpenAiCompatibleProvider` to NVIDIA's hosted API with the key
decided for that turn. Each job ends at its generation deadline at the latest, and an answer
whose job died with the process is failed as `interrupted` by the next request that touches its
session ([Failure handling](#failure-handling)). PostgreSQL is the only shared state; memory
holds what a restart may lose harmlessly (the text being streamed, abort controllers, capacity
reservations).

### Sending a message

```text
POST /sessions/:id/messages
  │  validate the body (no database access)
  ▼
admission transaction ── lock the session row (404)
  │                      stale reclaim: fail this session's dead generating turns
  │                      resolve provider and model: the message's override, else
  │                      the session's (422 provider_unavailable / model_not_supported)
  │                      does the message fit the model? (422 input_too_long)
  │                      decide the API key (422 llm_credential_missing)
  │                      a turn still generating? (409 session_busy)
  │                      reserve capacity: process + provider (503 server_busy /
  │                      provider_busy, Retry-After: 10)
  │                      t0 = monotonic clock; insert user + generating assistant
  │                      (started_at = clock_timestamp()), advance next_seq,
  │                      bump last_activity_at, title an untitled session
  ▼ commit
job (in process) ── no time left of GENERATION_DEADLINE_MS since t0? → failed (llm_timeout)
  │                context: system prompt + the newest earlier completed turns that
  │                fit the model's budget + the new message
  │                provider.stream() → deltas into the message's event bus
  │                every FLUSH_INTERVAL_MS: fenced UPDATE of the partial text
  │                deadline → failed (llm_timeout); shutdown → failed (cancelled)
  │                finish → fenced UPDATE to completed; error → failed with its llm_* code
  │                (the key is passed to the provider call only)
  │                every final state: retried within TERMINAL_WRITE_BUDGET_MS
  ▼ finally: drop the key, release capacity, leave the job map, close the bus
JSON response ── waits for the job's end or the effective wait, whichever is first,
                 then reads both rows: 200, 502 problem details, or 202 + Location
```

Every rule that must survive a restart or a second process lives in PostgreSQL: the row lock,
the partial unique index on generating turns, and the `attempt` fence on every generation
write. Memory only holds the stream buffer, the abort controller and capacity counters. See
[ADR 0003](docs/adr/0003-single-process-db-truth.md).

A turn's context is the frozen system prompt, then the newest completed turns with a lower
`seq` (user and assistant text) that fit the model's history budget, oldest first, then the
new message (see [Limits](#limits)). Turns are never split, and turns whose answer failed or
is still being generated are left out whole. An untitled session takes its title from the first non-blank
line of the message (whitespace collapsed, at most 60 characters including a closing `…`); a
title that is set is never overwritten.

## Long-running answers (JSON clients)

An answer can take from a second to minutes. A JSON send therefore waits only a bounded time
for it, and the client chooses how long with the standard `Prefer` header (RFC 7240):

| Request header                   | Waits                                     | `Preference-Applied` |
| -------------------------------- | ----------------------------------------- | -------------------- |
| (none)                           | `JSON_DEFAULT_WAIT_MS` (30 s)             | (absent)             |
| `Prefer: wait=10`                | 10 s, at most `JSON_MAX_WAIT_MS` (195 s)  | `wait=10`            |
| `Prefer: wait=600`               | the maximum                               | `wait=195`           |
| `Prefer: respond-async`          | not at all (also when `wait` is sent too) | `respond-async`      |
| malformed or unknown preferences | ignored: the default wait, never a 400    | (absent)             |

The answer decides the status: **200** completed, **502** failed (problem details with both
messages), **202** still being generated. A 202 carries both messages, `Location` (the
assistant message), `Retry-After: 2` and `Cache-Control: no-store`; generation goes on
(unless the server shuts down: then the answer fails as `cancelled`), and polling `Location`
returns the message's current state (partial text while generating), never from a cache,
until its status is `completed` or `failed`. `respond-async` means "do not wait",
not "always 202": an answer already known to be finished is still 200 or 502.

```sh
curl -i -X POST localhost:3000/sessions/<id>/messages -H 'content-type: application/json' \
  -H 'Prefer: respond-async' -d '{"content":"Hello"}'
# HTTP/1.1 202 Accepted
# location: /sessions/<id>/messages/<assistant id>
# retry-after: 2
# preference-applied: respond-async
curl -i localhost:3000/sessions/<id>/messages/<assistant id>   # poll until completed or failed
```

Always handle 202, even with a long `wait`: a proxy in front of the server may time out before
the configured maximum (lower `JSON_MAX_WAIT_MS` below it), and an answer whose final state
could not be stored stays `generating` until it is reclaimed (see below). A maximum wait
shorter than `GENERATION_DEADLINE_MS + TERMINAL_WRITE_BUDGET_MS` is allowed; the server logs a
notice at startup that long answers will then end in 202.
`Preference-Applied` reports which preferences were honoured; it promises neither completion
nor an exact wait. See [ADR 0004](docs/adr/0004-async-request-reply.md).

## Failure handling

Every rule below is decided by the database, not by memory, so it also holds after a crash.
See [ADR 0005](docs/adr/0005-deadline-reclaim.md).

| What goes wrong                                     | What the client sees                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| The model never finishes                            | After `GENERATION_DEADLINE_MS` (180 s, counted from admission): failed / `llm_timeout`, partial text kept |
| Admission took the whole deadline (slow database)   | failed / `llm_timeout` at once; the model is not called                                                   |
| The provider fails                                  | failed with its `llm_*` code (see below), partial text kept                                               |
| The server shuts down gracefully                    | failed / `cancelled`, partial text kept; a waiting JSON client gets that 502                              |
| The final state cannot be stored (database trouble) | The row stays `generating`; a waiting JSON client gets 202; then as for a crash                           |
| The process crashes or is killed                    | Within 240 s of the start: failed / `interrupted`, partial text kept                                      |

- **Deadline.** Each attempt is bounded by `GENERATION_DEADLINE_MS`, measured on a monotonic
  clock from just before the insert that records its `started_at`.
- **Final writes.** Storing `completed` or `failed` gets `TERMINAL_STATEMENT_TIMEOUT_MS` (3 s)
  per statement and `TERMINAL_WRITE_BUDGET_MS` (10 s) in total, retries with backoff
  included. If that is not enough the job logs it (assistant id, attempt, number of tries) and
  gives up.
- **Stale reclaim.** An answer still `generating` `GENERATION_DEADLINE_MS +
TERMINAL_WRITE_BUDGET_MS + RECLAIM_GRACE_MS` (240 s) after it started cannot have a live job
  any more. The next request that touches its session (reading the session, its messages or
  one message, changing the session, or sending a message) first fails such answers as
  `interrupted`; the comparison uses the database clock only. So after a crash a turn shows
  `generating` for up to four minutes, then the session takes new messages again. There is no
  background sweeper, lease or heartbeat: a session nobody touches keeps its dead row
  invisibly until somebody does.
- **Late writers.** A job that is somehow still running after its answer was reclaimed (a
  paused process, for example) is fenced: its next write matches no row and it stops without
  changing anything.
- **Graceful shutdown** (SIGTERM, SIGINT) stops admitting (503 `server_busy`), aborts the
  running answers, waits up to 1 s + `TERMINAL_STATEMENT_TIMEOUT_MS` +
  `TERMINAL_WRITE_BUDGET_MS` (14 s) for them to store `cancelled`, and forces exit 1 four
  seconds later (18 s) or on a second signal. Give
  the platform a longer stop grace period (compose uses 20 s). Answers not stored in time are
  reclaimed later.

## Limits

| Limit                          | Default                                                      | When it is reached                                                       |
| ------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Active answers in this process | 8 (`MAX_ACTIVE_GENERATIONS`)                                 | 503 `server_busy`, `Retry-After: 10`                                     |
| Active answers per provider    | catalog `maxConcurrency`, else 4 (`MAX_ACTIVE_PER_PROVIDER`) | 503 `provider_busy` naming the provider and its limit, `Retry-After: 10` |
| Active turns per session       | 1 (a database rule)                                          | 409 `session_busy`                                                       |
| Message length                 | 16,000 characters                                            | 400 `validation_error`                                                   |
| Message plus system prompt     | the model's context window, see below                        | 422 `input_too_long`                                                     |
| History sent to the model      | the model's history budget, see below                        | the oldest whole turns are left out                                      |
| Output per attempt             | the catalog's `maxOutputTokens`                              | finish reason `length`                                                   |
| Wall time per attempt          | 180 s (`GENERATION_DEADLINE_MS`)                             | failed / `llm_timeout`                                                   |

- **Capacity** is checked at admission, after the busy check and right before the turn is
  inserted, and taken synchronously. There is no queue or waiting room: a full server or
  provider answers at once and writes nothing. When both are full the process limit decides
  (`server_busy`). A slot is given back exactly once: when the admission fails after taking it
  (rolled back), otherwise when the answer's job ends, however it ends.
- **The counters are per process**, in memory. The service is designed to run as one process
  (see [ADR 0003](docs/adr/0003-single-process-db-truth.md)); while a deploy briefly overlaps
  two processes the effective limits double. Every active answer also uses database
  connections (history read, flushes, final write), so keep `MAX_ACTIVE_GENERATIONS` below the
  connection pool's size (node-postgres' default of 10).
- **History budget** = context window − `maxOutputTokens` − 10 % of the context window − the
  system prompt − the new message − 8 tokens per message sent. A negative budget means the
  message cannot fit at all: 422 `input_too_long` before anything is written. Otherwise the
  newest completed turns are taken while they fit, whole turns only, and sent oldest first.
- **Token counts are an estimate, not a bound**: each Han, Hiragana, Katakana or Hangul
  character counts as one token, and every three other characters (Unicode code points) as
  one. Real tokenizers differ by model; the 10 % margin absorbs most of the difference, and a
  provider that still reports a context overflow fails the answer as `llm_context_overflow`.
- Admission checks run in a fixed order and the first that fails decides the response: session
  exists (404), provider and model resolve (422), the message fits (422), an API key is
  available (422), the session is not busy (409), capacity (503).

## Providers and API keys

| Provider | Needs a key | Models (`config/models.json`)                  | Enable with                     |
| -------- | ----------- | ---------------------------------------------- | ------------------------------- |
| `demo`   | no          | `demo`: a fixed sentence, for trying the API   | (on by default)                 |
| `nvidia` | yes         | `meta/llama-3.2-11b-vision-instruct` (default) | `PROVIDERS_ENABLED=demo,nvidia` |

`nvidia` talks to NVIDIA's hosted OpenAI-compatible API through the official `openai` SDK; any
other OpenAI-compatible server can be added the same way. Only non-reasoning models are
catalogued, and only the answer content becomes text: reasoning side fields are ignored.
`GET /providers` lists the enabled providers, their models and `requiresKey`; it never says
whether the server has a key of its own.

**Live-verified.** Every catalogued NVIDIA model is checked against the real API by the
`live-llm` workflow before it is listed. Its result line on 2026-10-22
([run 39718461460](https://github.com/shaun0457/llm-chat-backend/actions/runs/39718461460)),
for "What is the capital of France?" with "Answer in one short sentence.":

```text
LIVE_RESULT {"model":"meta/llama-3.2-11b-vision-instruct","finishReason":"stop","usage":{"promptTokens":60,"completionTokens":8},"answer":"The capital of France is Paris."}
```

NVIDIA's hosted API queues requests to busy models; that call took about 60 s. Models that
answered 404 for the key's account, timed out, or reason before answering were left out
(ADR 0008, V3).

**Bring your own key.** Send your key in the `X-LLM-Api-Key` header of
`POST /sessions/:id/messages`. For each new turn the server uses, in this order: the header;
the server's own `<PROVIDER>_API_KEY` for the turn's provider; no key for a provider that
needs none; otherwise **422 `llm_credential_missing`**, before anything is stored. A malformed
header (not 1–512 visible ASCII characters) is a 400 that does not echo it.

**A server key is spent by anyone.** There is no authentication, so every enabled provider
that has a `<PROVIDER>_API_KEY` is usable by any client, for any of its catalogued models: a
session's settings and a message's `provider` / `model` override both pick from them. Enable a
provider with a server key only where that is acceptable, and keep its catalog to models whose
`maxOutputTokens` and cost you accept. The public demo runs without server keys.

```sh
curl -X POST localhost:3000/sessions -H 'content-type: application/json' \
  -d '{"provider":"nvidia"}'
curl -X POST localhost:3000/sessions/<id>/messages -H 'content-type: application/json' \
  -H "X-LLM-Api-Key: $NVIDIA_API_KEY" -d '{"content":"Hello"}'
```

**What happens to the key.** It is used for that one generation and then dropped. It is never
written to the database, never logged and never returned: it travels only inside the in-memory
job (in a holder that serialises as `[REDACTED]`), is passed to the provider call, and is
cleared when the job ends. Logs redact the `X-LLM-Api-Key` and `Authorization` headers and
`apiKey` fields, and write errors through an allowlist (no request options, headers, query
parameters or database error details). Upstream error text is scrubbed of the key, bearer
tokens and key query parameters before it is stored, returned or logged. Sentinel tests check
that a key appears in no log line, no database row and no response, also when the upstream
echoes it back. While a generation runs, its key is necessarily in process memory. A restart
loses running generations together with their keys; such an answer becomes `failed`/`interrupted`
([Failure handling](#failure-handling)) and is asked again in a new turn, with the key sent
again.

**Failures** are stored on the assistant message and answered with 502 in JSON mode:

| `errorCode`            | When                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `llm_auth_failed`      | the provider rejected the key (401/403); never retried                                         |
| `llm_context_overflow` | the provider said the input is too long for the model's context                                |
| `llm_timeout`          | no response headers within 60 s, on each of three attempts; or `GENERATION_DEADLINE_MS` passed |
| `llm_upstream_error`   | 429, 5xx, a connection error, a malformed stream, or no finish reason                          |

429, 5xx, connection errors and timeouts are retried twice by the SDK before they fail.
`errorDetail` is a short, scrubbed message (at most 500 characters), for example
`The model provider answered HTTP 401: …`. See [ADR 0008](docs/adr/0008-llm-port-byok.md).

## Build vs reuse

**Reused: Fastify with zod route schemas and `@fastify/swagger`.** One zod schema per route
validates the request, types the handler and generates the OpenAPI document, so the docs
cannot drift from what the server accepts, and `inject()` lets the tests drive the whole app
without a socket. The cost is coupling to the zod type provider: Fastify, zod and the provider
must be chosen as a compatible set ([ADR 0001](docs/adr/0001-stack-and-tooling.md)), and its
JSON Schema transform drops documented response headers, which `src/http/plugins.ts` puts
back. Express or a hand-written OpenAPI file would avoid that coupling, but validation, types
and docs would then be kept in step by hand.

**Reused: the official `openai` SDK for OpenAI-compatible providers.** It already parses the
streamed chunks, retries 429/5xx and connection errors with backoff, enforces request timeouts
and classifies errors, and a further OpenAI-compatible server is just another server-configured
base URL. The cost is adapting to its behaviour instead of owning it: `OpenAiCompatibleProvider`
creates a client per call so that a user's key never lives in a shared client, its retry
policy (two retries, 60 s per request) is the SDK's, and its error messages can echo request
details, so they are scrubbed before they are stored or logged
([ADR 0008](docs/adr/0008-llm-port-byok.md)). A hand-written client would mean reimplementing
stream parsing and retries.

**Built: an in-process job runner instead of a queue.** A generation runs as a job inside the
API process (`JobRegistry`, `src/modules/messages/jobs.ts`), started after the admission
transaction commits, with a `MessageBus` that holds the text so far. A queue (pg-boss, BullMQ
on Redis, or a jobs table with `SKIP LOCKED`) would scale out, but adds a second moving part,
leases, heartbeats, a sweeper and a hand-off between the worker and the request waiting for
the answer. The cost is a single API process: capacity and live text are per process, and a
restart loses the running generations. Correctness never depends on that memory: the row lock,
the partial unique index and fenced writes in PostgreSQL decide every outcome
([ADR 0003](docs/adr/0003-single-process-db-truth.md)), and an answer cut off by a restart is
reclaimed from the database alone: after a fixed threshold it becomes `failed`/`interrupted`
([ADR 0005](docs/adr/0005-deadline-reclaim.md)). The price is that the session shows the dead
answer as `generating`, and stays busy, for up to four minutes.

## Test

```sh
pnpm lint:ci     # ESLint without --fix, zero warnings allowed
pnpm typecheck   # tsc --noEmit
pnpm test:unit   # unit and lint tests only; no Docker needed
pnpm test        # everything; Docker must be running (testcontainers)
```

Integration tests need Docker; `pnpm test` runs at most two test files at a time to keep memory
low on a laptop.

### Testing approach

Tests check external behaviour: status codes, headers, bodies, and rows as the API returns them.
They do not assert on internal calls, map contents or private state. A few boundary
observations are allowed because some guarantees can only be seen there: the fake provider
records the requests it receives (to check what context a turn sent), read-only database
queries check that no column holds an API key, and the crash-recovery tests insert the
`generating` row a crashed process would have left behind.

| Layer            | Where                    | What it covers                                                                                                                                                                                                                  |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit             | `test/unit`, `test/lint` | Pure pieces: configuration, catalog, `Prefer` parsing, context assembly, cursors, the scrubber, deadline arithmetic, timeout races, the terminal-write budget, shutdown timing, the OpenAPI file; the dependency-direction rule |
| Adapter contract | `test/adapters`          | `OpenAiCompatibleProvider` against an msw-mocked upstream API                                                                                                                                                                   |
| Integration      | `test/integration`       | Nearly every behaviour, through HTTP: `buildApp()` and `inject()` against a real PostgreSQL 17, with a fake LLM provider                                                                                                        |
| Process          | `test/process`           | The built server and migration entries as child processes (startup errors, signals, a shutdown that cannot finish), and Node's server timeouts on a real listening socket                                                       |
| CI only          | `.github/workflows`      | The container image, the `docker compose` stack, migration and OpenAPI drift, and the live hosted-model checks                                                                                                                  |

Integration tests start one PostgreSQL 17 container per run (testcontainers), migrate a
template database once, and give every test file its own copy, so files run in parallel
without seeing each other's rows. Locks, unique constraints, conditional updates and statement
timeouts are therefore tested for real, not against a mock database. Time-dependent rules run
with scaled-down settings: tests build the app with a generation deadline of a few hundred
milliseconds or a short terminal-write budget, a test clock (`test/helpers/clock.ts`) makes an
admission look slow, and crashed rows get a `started_at` minutes in the past.

**How the LLM is faked.** The test suite never calls a real LLM provider; the boundary is faked
at two levels. Service and integration tests inject `FakeLlmProvider`
(`test/helpers/fake-llm.ts`), a scriptable implementation of the provider port: deltas, delays,
gates, hangs, failures, a missing finish event, and usage, while it records the requests, abort
signals and API keys it received. The OpenAI-compatible adapter itself is tested from the other
side of the port, against an [msw](https://mswjs.io/)-mocked upstream HTTP API
(`test/helpers/msw-openai.ts`): chunk arrangements, reasoning fields, 401/403, 429 then
success, persistent 5xx, context overflow and timeouts. The sentinel tests combine the real
adapter with msw.

**Against the real provider.** An opt-in live check calls every catalogued NVIDIA model through
the adapter: `LLM_LIVE_TESTS=1 NVIDIA_API_KEY=… pnpm test:unit`. It is skipped otherwise. In CI
only the `live-llm` workflow runs it, with the repository secret: on pushes to `main`, by hand,
or on a pull request from this repository labelled `live-llm`. A second job of that workflow
starts the built image with `docker compose`, the server's key and a CI-only catalog copy that
caps answers at 32 tokens, creates an `nvidia` session and asks one question through
`POST /sessions/:id/messages` (JSON, `Prefer: wait=150`). It passes only with a completed,
non-empty answer, prints just the answer and its usage, and fails if a response or the
container logs contain a key-shaped string. Neither job is a required check.

**Not tested on purpose.** The quality of real model answers (the live checks prove the path,
not the content); mutation testing; load and performance; running more than one API process,
which is out of scope. A response-conformance test against the OpenAPI document and
property-based tests are listed under [What I would do next](#what-i-would-do-next).

CI runs the same commands plus a container build-and-start check, a migration drift check, an
OpenAPI drift check, a `docker compose` smoke test, a production dependency audit, a gitleaks
secret scan and a commit-message check. CodeQL runs once the repository is public; code
scanning on private repositories needs a paid license.

## API documentation

- Interactive docs: `GET /docs`
- OpenAPI 3.1 document: `GET /openapi.json`
- In the repository: [`docs/openapi.json`](docs/openapi.json), the same document with sorted
  keys, readable without running anything

All three come from the same zod schemas that validate requests. Errors use RFC 9457 problem
details (`application/problem+json`) with a stable `code` field.

`pnpm docs:openapi` regenerates `docs/openapi.json` from the app factory with fixed test
settings (no database, no `.env`), so every machine writes the same bytes. Any pull request
that changes a route schema regenerates and commits it; otherwise the CI job `openapi-drift`
fails with "docs/openapi.json is stale".

Decisions are recorded in [`docs/adr`](docs/adr).

## What I would do next

A first version of this list; the final submission pass completes it.

**Still being built for v1**, each as its own ticket:

- Streaming (SSE) and re-attaching to a running answer
  ([#9](https://github.com/shaun0457/llm-chat-backend/issues/9))
- Idempotent send with client-supplied message ids
  ([#10](https://github.com/shaun0457/llm-chat-backend/issues/10))
- A local model via Ollama as an optional compose profile
  ([#11](https://github.com/shaun0457/llm-chat-backend/issues/11))
- Stopping a generation when its session is deleted, retention of inactive sessions, rate
  limits, security headers and CORS ([#12](https://github.com/shaun0457/llm-chat-backend/issues/12))
- A public deployment of the demo ([#14](https://github.com/shaun0457/llm-chat-backend/issues/14))

**Extras after v1:**

- Retrying a failed answer, made repeatable with `expectedAttempt`
  ([#13](https://github.com/shaun0457/llm-chat-backend/issues/13))
- `expectedLastMessageId` and 409 `stale_history`, so two tabs cannot talk over each other
  ([#23](https://github.com/shaun0457/llm-chat-backend/issues/23))
- SSE slow-consumer edge cases and a JSON-mode test of terminal-write exhaustion
  ([#24](https://github.com/shaun0457/llm-chat-backend/issues/24))
- Deployment hardening: a platform comparison, verified live SSE, proxy-timeout measurement,
  client-IP verification and a post-deploy check
  ([#25](https://github.com/shaun0457/llm-chat-backend/issues/25))
- Submission extras: a response-conformance test against the OpenAPI document, more diagrams, a
  load script and property-based tests
  ([#26](https://github.com/shaun0457/llm-chat-backend/issues/26))

**Deliberately out of scope:**

- User accounts, authentication and per-user ownership. Sessions are global: anyone who can
  reach the API can read, change or delete any session. Authentication would come first, before
  any real users.
- A per-session message queue: a busy session answers 409 instead.
- Leases, heartbeats, a background sweeper or a job worker table, a generic `Idempotency-Key`
  store, and more than one API instance with shared capacity limits. The database rules keep a
  brief deploy overlap correct; these pay off only with several instances.
- Storing or registering API keys on the server: a key lives in memory for one generation only.
- A waiting room for busy providers: a full provider answers 503 at once instead of queueing
  (see [Limits](#limits)).
- `Last-Event-ID` resumption of streams, streaming the model's reasoning, and branching or
  editing messages (history is linear).
- Metrics and tracing beyond structured logs, a frontend, and evaluating answer quality.
- A native Anthropic adapter: optional, only after everything above.
