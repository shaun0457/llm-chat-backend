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

| Assignment item (paraphrased)                                   | README section                                                                         |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Manage many chat sessions: create, list, read, update, delete   | [Query support](#query-support)                                                        |
| Send a message, get the model's answer, keep the history        | [Sending a message](#sending-a-message), [Database schema](#database-schema)           |
| Cope with answers that take a long time                         | [Long-running answers](#long-running-answers-json-clients)                             |
| Talk to a real LLM provider, with the user's own API key        | [Providers and API keys](#providers-and-api-keys)                                      |
| Start everything with one command                               | [Run with Docker](#run-with-docker)                                                    |
| An architecture diagram                                         | [Architecture](#architecture)                                                          |
| The database schema                                             | [Database schema](#database-schema)                                                    |
| What the API can query                                          | [Query support](#query-support)                                                        |
| How to run the tests, and how the code is tested                | [Test](#test), [Testing approach](#testing-approach)                                   |
| Two or three build-versus-reuse decisions with their trade-offs | [Build vs reuse](#build-vs-reuse)                                                      |
| Where the API documentation is                                  | [API documentation](#api-documentation)                                                |
| Why it was built this way                                       | [`docs/adr`](docs/adr)                                                                 |
| Safe to expose publicly: abuse limits, no authentication        | [Security considerations](#security-considerations), [Data retention](#data-retention) |
| Bonus items: streaming, a local model, a public deployment      | [Streaming](#streaming-sse), [Local model](#local-model-ollama); deployment: to follow |

## Prerequisites

- Docker with Compose v2.20 or later (the stack uses `depends_on: required: false`), for the
  one-command stack and the integration tests
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
be positive whole numbers of milliseconds, at most one hour. `NVIDIA_BASE_URL` and
`OLLAMA_BASE_URL` are checked only when their provider is enabled.

| Variable                        | Default                      | Meaning                                                                                                                                                   |
| ------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                  | (required)                   | `postgres://` or `postgresql://` connection URL                                                                                                           |
| `PORT`                          | `3000`                       | Listening port                                                                                                                                            |
| `HOST`                          | `0.0.0.0`                    | Listening address                                                                                                                                         |
| `LOG_LEVEL`                     | `info`                       | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`                                                                                            |
| `NODE_ENV`                      | `production`                 | `development`, `test` or `production`                                                                                                                     |
| `MODEL_CATALOG_PATH`            | bundled `config/models.json` | Model catalog file (see below)                                                                                                                            |
| `PROVIDERS_ENABLED`             | `demo`                       | Comma-separated provider ids; each must be in the catalog                                                                                                 |
| `DEFAULT_PROVIDER`              | `demo`                       | Provider for sessions created without one; must be enabled                                                                                                |
| `DEFAULT_MODEL`                 | the provider's default       | Model for sessions created with neither provider nor model; must be in the catalog                                                                        |
| `DEFAULT_SYSTEM_PROMPT`         | (none)                       | System prompt for turns of sessions without their own (up to 8,000 characters)                                                                            |
| `FLUSH_INTERVAL_MS`             | `1000`                       | How often a generating answer's partial text is written to the database (10–60,000)                                                                       |
| `DEMO_DELAY_MS`                 | `50`                         | Pause between the demo provider's chunks (0–10,000)                                                                                                       |
| `JSON_DEFAULT_WAIT_MS`          | `30000`                      | How long a JSON send waits for its answer without `Prefer: wait` (0–600,000)                                                                              |
| `JSON_MAX_WAIT_MS`              | `195000`                     | The longest a JSON send ever waits (0–600,000); keep it below your proxy's timeout                                                                        |
| `GENERATION_DEADLINE_MS`        | `180000`                     | Hard limit of one generation attempt, from admission; then it fails as `llm_timeout`                                                                      |
| `TERMINAL_STATEMENT_TIMEOUT_MS` | `3000`                       | Limit of each statement that stores an answer's final state                                                                                               |
| `TERMINAL_WRITE_BUDGET_MS`      | `10000`                      | Limit of storing the final state, retries included; also bounds graceful shutdown                                                                         |
| `RECLAIM_GRACE_MS`              | `50000`                      | Margin before a generating row with no live job counts as dead; ≥ statement timeout + 1 s                                                                 |
| `SSE_PING_INTERVAL_MS`          | `15000`                      | How often a quiet event stream gets a `: ping` comment (100 ms to one hour)                                                                               |
| `SSE_BUFFER_LIMIT_BYTES`        | `262144`                     | Bytes an event stream may have waiting for a slow client before it is closed (16 KiB–64 MiB)                                                              |
| `MAX_ACTIVE_GENERATIONS`        | `8`                          | Active answers in this process at most; then 503 `server_busy` (1–10,000)                                                                                 |
| `MAX_ACTIVE_PER_PROVIDER`       | `4`                          | Active answers per provider unless its catalog entry sets `maxConcurrency`; then 503 `provider_busy` (1–10,000)                                           |
| `NVIDIA_BASE_URL`               | NVIDIA's public endpoint     | The `nvidia` provider's OpenAI-compatible API (`http`/`https`); clients can never choose a URL                                                            |
| `OLLAMA_BASE_URL`               | `http://localhost:11434/v1`  | The `ollama` provider's OpenAI-compatible API (`http`/`https`); docker compose sets `http://ollama:11434/v1`                                              |
| `<PROVIDER>_API_KEY`            | (none)                       | The server's own key for an enabled provider, e.g. `NVIDIA_API_KEY` (1–512 visible ASCII); never used for a provider with `requiresKey: false`            |
| `RATE_LIMIT_GENERAL_PER_MIN`    | `120`                        | Requests per minute per client address to every route except `/health*`; then 429 `rate_limited`                                                          |
| `RATE_LIMIT_SEND_PER_MIN`       | `20`                         | Sends (`POST /sessions/:id/messages`, replays included) per minute per client address, on top of the general limit                                        |
| `TRUST_PROXY`                   | (none)                       | Comma-separated IPs or CIDR ranges of proxies whose `X-Forwarded-For` is believed; no hop counts, `true`, `*`, or ranges shorter than IPv4 /8 or IPv6 /16 |
| `CORS_ORIGINS`                  | (none)                       | Comma-separated `http(s)://host[:port]` origins allowed by CORS, or `*` alone; unset: no CORS headers                                                     |
| `RETENTION_DAYS`                | (none)                       | Delete sessions inactive for longer than this many days (1–3,650); unset: never                                                                           |
| `RETENTION_INTERVAL_MS`         | `3600000`                    | How often retention runs while `RETENTION_DAYS` is set (10 ms to one day)                                                                                 |
| `DB_STATEMENT_TIMEOUT_MS`       | `10000`                      | Default limit of every database statement, lock waits included (100 ms to one hour)                                                                       |
| `REQUEST_TIMEOUT_MS`            | `30000`                      | How long a client may take to send a whole request (headers and body); then 408, at most a tenth later. Never limits a response (1,000–600,000)           |

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

| Endpoint                                 | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /sessions`                         | 201 + `Location`. Provider/model default to the configuration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /sessions`                          | `?limit=` 1–100 (default 20), `?cursor=` from the previous `nextCursor`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /sessions/:id`                      | 404 `session_not_found` if missing, 400 for a malformed id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PATCH /sessions/:id`                    | Any of `title`, `provider`, `model`, `systemPrompt`; `null` clears title or prompt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `DELETE /sessions/:id`                   | 204 with all its messages, then 404; a running answer is stopped at once                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST /sessions/:id/messages`            | `{ "id"?, "content", "provider"?, "model"? }` (content 1–16,000 characters, not blank; unknown fields are a 400). `id` is your own UUID for the user message: repeating the send replays the stored turn, and an id used otherwise is 422 `message_id_conflict` ([Safe retries](#safe-retries)). `provider`/`model` override the session's pair for this turn only. With `Accept: text/event-stream` an event stream ([Streaming](#streaming-sse)); otherwise waits a bounded time (see below): 200 `{ userMessage, assistantMessage }`, 502 problem details with both messages when it failed (`code` is the answer's `errorCode`), 202 with both messages while it is still generating. 422 `provider_unavailable` / `model_not_supported` for a pair that does not resolve, 422 `input_too_long` when the message cannot fit the model (see [Limits](#limits)), 409 `session_busy` while the session's previous answer is generating, 503 `server_busy` / `provider_busy` with `Retry-After: 10` at a capacity limit or while the server shuts down |
| `GET /sessions/:id/messages`             | `?limit=` 1–200 (default 50), `?before=` a message id of this session; newest page first, ascending `seq` within a page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /sessions/:id/messages/:mid`        | One message, including the partial text of an answer being generated; `Cache-Control: no-store`; 404 `message_not_found` outside this session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /sessions/:id/messages/:mid/events` | Event stream of an assistant message: the text so far, then the rest live ([Streaming](#streaming-sse)); 404 `message_not_found` unless it is an assistant message of this session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /providers`                         | Enabled providers, whether they need a key, their catalogued models                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /health`                            | Liveness, no dependencies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /health/ready`                      | 200 when the database answers and its migrations match this build                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

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
    subgraph localllm["profile local-llm (optional)"]
      ollamaPull["ollama-pull<br/>one-shot: pulls the catalogued model"]
      ollama["ollama<br/>CPU only, 2 parallel answers, internal network"]
    end
    subgraph api["api: dist/index.js, one process built by buildApp()"]
      routes["Fastify routes<br/>health · providers · sessions · messages<br/>zod schemas: validation and /openapi.json<br/>helmet · CORS · per-address rate limits"]
      services["sessions service: deleteSession, retention interval<br/>messages service: admission transaction<br/>stale reclaim on every session-scoped request"]
      jobs["JobRegistry<br/>in-process jobs, one MessageBus each<br/>generation deadline, terminal-write budget<br/>process and provider capacity counters"]
      registry["ProviderRegistry<br/>ModelCatalog: config/models.json"]
      port{{"LlmProvider port"}}
      demo["DemoProvider<br/>no key"]
      openai["OpenAiCompatibleProvider<br/>openai SDK, a client per call"]
    end
  end

  client -- "HTTP: JSON or SSE" --> routes
  routes --> services
  services --> jobs
  services --> registry
  registry --> port
  jobs -- "stream(request, key)" --> port
  port --- demo
  port --- openai
  openai -- "the turn's key, server-defined base URL" --> nvidia
  openai -. "no key, OLLAMA_BASE_URL" .-> ollama
  ollamaPull -- "ollama pull" --> ollama
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
decided for that turn; `ollama`, with the `local-llm` profile, goes through the same adapter to
a local Ollama server without a key ([Local model](#local-model-ollama)). Each job ends at its
generation deadline at the latest, and an answer whose job died with the process is failed as
`interrupted` by the next request that touches its session
([Failure handling](#failure-handling)). PostgreSQL is the only shared state; memory holds what
a restart may lose harmlessly (the text being streamed, abort controllers, capacity
reservations).

### Sending a message

```text
POST /sessions/:id/messages
  │  validate the body (no database access)
  ▼
admission transaction ── lock the session row (404)
  │                      stale reclaim: fail this session's dead generating turns
  │                      body id already stored? the same send → replay the stored
  │                      turn, skip every step below (else 422 message_id_conflict)
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
SSE response  ── message.created (snapshot), then the bus's deltas, then done or error
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

## Streaming (SSE)

Send with `Accept: text/event-stream` and the answer arrives as server-sent events while it is
generated. Refusals found before the stream starts (400, 404, 409, 422, 503) are ordinary
problem details; once the stream has started the status is 200 and a failed answer is the
`error` event.

The server compares q-values. It streams only when `text/event-stream` is listed by name with
a q above 0 and above the q of `application/json`, which `application/*` and `*/*` also match.
A tie, a wildcard alone, or no `Accept` answers JSON:

- `text/event-stream` and `text/event-stream, application/json;q=0.9` stream;
- `application/json, text/event-stream;q=0.5`, `text/event-stream, */*` and
  `text/event-stream;q=0` answer JSON.

Every response of the send route carries `Vary: Accept`.

```sh
curl -N -X POST localhost:3000/sessions/<id>/messages -H 'content-type: application/json' \
  -H 'Accept: text/event-stream' -d '{"content":"Hello"}'
# event: message.created
# data: {"userMessage":{...},"assistantMessage":{"id":"<assistant id>","status":"generating","content":"",...}}
#
# event: delta
# data: {"id":"<assistant id>","attempt":1,"text":"Hel"}
#
# event: done
# data: {"assistantMessage":{"id":"<assistant id>","status":"completed","content":"Hello…","usage":{...},...}}
curl -N localhost:3000/sessions/<id>/messages/<assistant id>/events   # re-attach at any time
```

| Event              | Data                                 | Meaning                                                                        |
| ------------------ | ------------------------------------ | ------------------------------------------------------------------------------ |
| `message.created`  | `{ userMessage, assistantMessage }`  | Always first: both messages as they are now; the content may already have text |
| `delta`            | `{ id, attempt, text }`              | Text after the snapshot, each piece exactly once                               |
| `done`             | `{ assistantMessage }`               | Completed, with usage; the stream ends                                         |
| `error`            | `{ code, detail, assistantMessage }` | Failed (the `errorCode` table below); the stream ends                          |
| `message.detached` | `{ assistantMessage }`               | Being generated where this server cannot follow it: poll the message instead   |

- **Closing the connection never stops the answer.** It is generated and stored as usual; read
  it with `GET /sessions/:id/messages/:mid` or follow it again with `…/events`. A JSON client
  that got a 202 can follow the same answer there too.
- **Re-attaching** sends the text so far in `message.created` and then only the rest, with no
  gap and no duplicate. A finished message gets `message.created` and `done` or `error`; a
  message left `generating` by a crashed process gets `message.detached` until stale reclaim
  fails it as `interrupted` (after that, `error`). There is no `Last-Event-ID`: a reconnect
  always starts from a fresh snapshot.
- **A deleted turn's stream ends without a final event.** Deleting the session stops the
  generation at once and closes every open stream of it cleanly, with no `done` or `error`
  event; following it again (`…/events`) then answers 404. A JSON send that was still waiting
  for the answer gets 404 `session_not_found`.
- **Proxies.** A `: ping` comment every 15 s (`SSE_PING_INTERVAL_MS`) keeps idle connections
  open; responses carry
  `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`, and the API never
  compresses them. Proxies that still buffer deliver the events late; JSON with polling works
  everywhere.
- **Slow clients** that stop reading are disconnected once more than 256 KiB would be waiting
  for them (`SSE_BUFFER_LIMIT_BYTES`); the answer is still stored. A single event written while
  nothing is waiting always goes out, however large.
- **Configurable.** The ping interval (`SSE_PING_INTERVAL_MS`, 15 s by default) and the buffer
  limit (`SSE_BUFFER_LIMIT_BYTES`, 256 KiB by default) are set in the environment; see
  [Configuration](#configuration).

See [ADR 0006](docs/adr/0006-sse-reattach.md).

## Safe retries

A client that times out or loses its connection cannot tell whether its message was stored.
To make a send safe to repeat, give the user message your own id (any UUID) and send exactly
the same request again:

```sh
curl -i -X POST localhost:3000/sessions/<id>/messages -H 'content-type: application/json' \
  -d '{"id":"6f1c2b9e-3d4a-4c5b-9e8f-0a1b2c3d4e5f","content":"Hello"}'
```

- **A repeat is a replay.** When a user message with that id exists in this session with
  byte-identical content (and the request's `provider`/`model`, where it names them, are the
  ones the turn was generated with), nothing new is admitted and the model is not called
  again. The response is the stored turn as it is now, in the form the request asks for:
  JSON 200 (completed), 502 (failed) or 202 (still generating, or the outcome if it ends
  within the wait), or an event stream (the snapshot, then the live deltas and `done`/`error`,
  exactly like re-attaching).
- **A replay checks nothing else.** It is detected right after the session lock and stale
  reclaim, so it answers without `X-LLM-Api-Key`, after the session's provider or model
  changed, while the session is busy with that very turn, and when capacity is full. It writes
  nothing of its own, not even the session's activity time; only stale reclaim, which every
  request to the session runs first, may fail a dead answer as `interrupted`.
- **Any other use of the id is 422 `message_id_conflict`**: the id belongs to a message in
  another session or to an assistant message, the content differs, or the request names a
  different provider or model. The `detail` says which, without showing the stored message.
- **The guarantee.** The server never admits the same send twice, also when two copies race
  (within a session the row lock orders them; across sessions the primary key does, and the
  loser is answered 422). It cannot guarantee that the upstream model ran exactly once: an
  answer that failed was still a call to the model.
- **Limits.** Content is compared exactly, so a client that re-normalises text (a trailing
  newline, Unicode normalisation) gets 422 instead of a replay. Ids are global: one id cannot
  be reused in another session, so generate them at random (a v4 or v7 UUID), never from a
  counter or the content, or someone who guesses an id can take it first. Without an id there is no deduplication: two identical sends
  create two turns, or the second gets 409 `session_busy` while the first is generating.
  Retrying a failed answer (a new attempt of the same turn) is not built yet; see
  [What I would do next](#what-i-would-do-next).

See [ADR 0007](docs/adr/0007-idempotency-client-ids.md).

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

| Limit                          | Default                                                               | When it is reached                                                       |
| ------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Active answers in this process | 8 (`MAX_ACTIVE_GENERATIONS`)                                          | 503 `server_busy`, `Retry-After: 10`                                     |
| Active answers per provider    | catalog `maxConcurrency`, else 4 (`MAX_ACTIVE_PER_PROVIDER`)          | 503 `provider_busy` naming the provider and its limit, `Retry-After: 10` |
| Active turns per session       | 1 (a database rule)                                                   | 409 `session_busy`                                                       |
| Message length                 | 16,000 characters                                                     | 400 `validation_error`                                                   |
| Message plus system prompt     | the model's context window, see below                                 | 422 `input_too_long`                                                     |
| History sent to the model      | the model's history budget, see below                                 | the oldest whole turns are left out                                      |
| Output per attempt             | the catalog's `maxOutputTokens`                                       | finish reason `length`                                                   |
| Wall time per attempt          | 180 s (`GENERATION_DEADLINE_MS`)                                      | failed / `llm_timeout`                                                   |
| Requests per client address    | 120 a minute (`RATE_LIMIT_GENERAL_PER_MIN`), not `/health*`           | 429 `rate_limited`, `Retry-After` in seconds                             |
| Sends per client address       | 20 a minute (`RATE_LIMIT_SEND_PER_MIN`), replays included             | 429 `rate_limited`, `Retry-After` in seconds                             |
| Request body                   | 128 KiB                                                               | 413 `request_error`                                                      |
| Time to send a request         | 30 s (`REQUEST_TIMEOUT_MS`; enforced within 33 s), never the response | 408, the connection is closed                                            |
| One database statement         | 10 s (`DB_STATEMENT_TIMEOUT_MS`), lock waits included                 | 500 `internal_error`, logged                                             |

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
  exists (404), a repeated send replays (or 422 `message_id_conflict`) before anything else
  is checked, provider and model resolve (422), the message fits (422), an API key is
  available (422), the session is not busy (409), capacity (503).

## Providers and API keys

| Provider | Needs a key | Models (`config/models.json`)                                    | Enable with                                                                                       |
| -------- | ----------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `demo`   | no          | `demo`: a fixed sentence, for trying the API                     | (on by default)                                                                                   |
| `nvidia` | yes         | `nvidia/nemotron-3-ultra-550b-a55b` (default), a reasoning model | `PROVIDERS_ENABLED=demo,nvidia`                                                                   |
| `ollama` | no          | `qwen2.5:0.5b` (default), local, CPU only                        | `PROVIDERS_ENABLED=demo,ollama` with the `local-llm` profile ([Local model](#local-model-ollama)) |

`nvidia` talks to NVIDIA's hosted OpenAI-compatible API through the official `openai` SDK; any
other OpenAI-compatible server can be added the same way. Only the answer content becomes text.
`nemotron-3-ultra` reasons before it answers, and its reasoning (`reasoning_content` or
`reasoning`) is never read: it is not stored, returned, streamed, logged or sent as history.
While the model reasons, an event stream shows only `message.created` and `: ping` comments,
and a JSON client simply waits. An answer that ends without any text, typically because the
reasoning used up `maxOutputTokens`, fails as `llm_upstream_error` instead of completing empty.
Answers are the model's text as written, which may include Markdown such as `**bold**`.
`GET /providers` lists the enabled providers, their models and `requiresKey`; it never says
whether the server has a key of its own.

**Live-verified.** Every catalogued NVIDIA model is checked against the real API by the
`live-llm` workflow before it is listed. Its result line on 2026-10-22
([run 39808368033](https://github.com/shaun0457/llm-chat-backend/actions/runs/39808368033)),
for "What is the capital of France?" with "Answer in one short sentence.":

```text
LIVE_RESULT {"model":"nvidia/nemotron-3-ultra-550b-a55b","finishReason":"stop","usage":{"promptTokens":29,"completionTokens":34},"answer":"The capital of France is Paris."}
```

The completion tokens include the reasoning. In a benchmark of the five models the key could
use (20 calls each), `nemotron-3-ultra` answered every time, with its first answer token after
2.0 s (median) and the whole answer after 6.7 s (median) and 19.4 s (p95); the model it
replaced answered 3 of 5 times. Models that answered 404 for the key's account were left out
(ADR 0008, amendment for issue #36).

**Bring your own key.** Send your key in the `X-LLM-Api-Key` header of
`POST /sessions/:id/messages`. A provider that needs no key (`requiresKey: false`, such as
`demo` and `ollama`) never receives one: for its turns the header and any server key are
ignored, so your key never reaches a service that has no use for it. For a provider that needs
a key the server uses, for each new turn and in this order: the header; the server's own
`<PROVIDER>_API_KEY` for the turn's provider; otherwise **422 `llm_credential_missing`**,
before anything is stored. A malformed header (not 1–512 visible ASCII characters) is a 400
that does not echo it, whatever the provider.

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
| `llm_upstream_error`   | 429, 5xx, a connection error, a malformed stream, no finish reason, or no answer text at all   |

429, 5xx, connection errors and timeouts are retried twice by the SDK before they fail.
`errorDetail` is a short, scrubbed message (at most 500 characters), for example
`The model provider answered HTTP 401: …`. See [ADR 0008](docs/adr/0008-llm-port-byok.md).

## Local model (Ollama)

An optional compose profile runs a small model on your own machine, with no key and no hosted
provider. One command turns it on:

```sh
docker compose --env-file local-llm.env up --build
curl -X POST localhost:3000/sessions -H 'content-type: application/json' \
  -d '{"provider":"ollama"}'
curl -X POST localhost:3000/sessions/<id>/messages -H 'content-type: application/json' \
  -H 'Prefer: wait=180' -d '{"content":"What is 2+2? Answer with one number."}'
```

The profile adds two services. `ollama` runs a pinned `ollama/ollama` image on the internal
network only (it is not published to the host) and keeps models in the `ollama-models` volume.
`ollama-pull` is a one-shot job that starts once Ollama is healthy and pulls the catalogued
model, `qwen2.5:0.5b` (about 400 MB). The API starts only after that job has exited 0. Later
starts find the model in the volume and download nothing again. Without the profile none of
this runs and the stack is unchanged.

[`local-llm.env`](local-llm.env) sets two things: `COMPOSE_PROFILES=local-llm`, which starts
the profile, and `PROVIDERS_ENABLED=demo,ollama`, which enables the provider; `demo` stays the
default provider and every other setting keeps its default. With `--env-file`, compose does
not read `.env`; to keep your own settings too, pass both, yours first:
`docker compose --env-file .env --env-file local-llm.env up --build`. The profile alone does
not enable the provider, and enabled without the profile, `ollama` stays listed but every
answer fails as `llm_upstream_error`, because nothing answers at its address. Ollama is on its
own compose network with the api; PostgreSQL is not on it.
`docker compose --env-file local-llm.env down -v` also removes the model volume.

The compose file repeats three catalog values: the model it pulls, `OLLAMA_NUM_PARALLEL`
(the catalog's `maxConcurrency`) and the context (twice the `contextWindow`). A unit test
keeps them in step with the shipped catalog; a different catalog (`MODEL_CATALOG_PATH`) needs
the same changes in the compose file.

- **Same adapter, different configuration.** `ollama` uses the OpenAI-compatible adapter that
  `nvidia` uses, pointed at `OLLAMA_BASE_URL` and called with the placeholder key `no-key`,
  which Ollama ignores. There is no Ollama-specific code path; only two adapter settings
  differ. A request may take 120 s instead of 60 s to start and between chunks, since a CPU
  model can need over a minute before its first token. A failed request is not retried, because
  a retry would repeat the whole prompt evaluation inside the same 180 s deadline.
- **Hardware.** CPU only; GPU configuration is out of scope. The model needs about 1 GB of
  memory with two 8,192-token contexts. Any machine that runs Docker comfortably can run it,
  but answers are slow.
- **Speed.** Measured on a GitHub runner with 2 CPUs and 7.8 GiB of memory (2026-10-22,
  [run 39755308412](https://github.com/shaun0457/llm-chat-backend/actions/runs/39755308412)):
  the model download took 8 s; the first question took 1.1 s to the first token and 1.2 s in
  all, including loading the model; with the model loaded, a short JSON answer took 0.16 s.
  Two 512-token answers at once took about 36 s each, about 14 tokens per second per answer.
  The whole CI job, with a cold model cache, took 3 min 22 s. A slower machine takes
  proportionally longer, still well inside the 180 s deadline.
- **The limit is 2.** Ollama answers `OLLAMA_NUM_PARALLEL=2` requests at a time, and the
  catalog gives `ollama` the same number as `maxConcurrency`. A third concurrent send gets
  503 `provider_busy` with `Retry-After: 10` at once and writes nothing. Without the limit,
  Ollama would queue the third request while its 180 s generation deadline runs, and on a CPU
  every queued answer would risk ending as `llm_timeout`.
- **Context window and output.** The catalog's `contextWindow` is 4,096 tokens, and the
  history budget keeps each prompt within it by an estimate. Ollama gives each request
  `OLLAMA_CONTEXT_LENGTH=8192`, twice as much, because it does not reject a prompt longer than
  its context: it silently drops the start. The headroom absorbs an estimate that is too low,
  for example for digits, which this model reads one token each. (Ollama's OpenAI-compatible
  endpoint cannot set the context per request.) Answers stop at the catalog's
  `maxOutputTokens` of 512 (finish reason `length`).
- **Why this model.** `qwen2.5:0.5b` is the instruction-tuned Qwen 2.5 with 0.5 billion
  parameters, 4-bit quantised. It answers simple questions coherently, and it is not a
  reasoning model: its answers carry no `<think>` blocks in the content.

**Proven in CI.** The `local-llm` workflow brings this stack up on a GitHub runner and runs
`apps/server/scripts/smoke-local-llm.ts` against it. The script asks "What is 2+2? Answer with
one number." once as an event stream, which must end with `done`, and once as JSON with
`Prefer: wait=180`, where a 202 is followed by polling. Both must end in a completed, non-empty
answer without reasoning markers. Then two long answers run at once: a third send must get
503 `provider_busy`; at least one of the two answers must stop at the 512-token limit (finish
reason `length`), and neither may go past it. The workflow starts the stack with the command
above. It runs on
pushes to `main`, on pull requests that touch provider, catalog or compose files, on pull
requests from this repository labelled `local-llm`, and by hand. It caches the model between
runs and is not a required check. The script works against any base URL and provider, for
example `node apps/server/scripts/smoke-local-llm.ts --base-url http://127.0.0.1:3000 --provider demo`.

## Security considerations

**There is no authentication.** Sessions are global: anyone who can reach the API, and on the
public demo that is anyone, can list, read, change and delete every session and its messages.
Do not put anything private into the demo. This is a deliberate trade-off for an evaluation
service; the protections below limit abuse, not access.

What is in place:

- **Rate limits per client address** (in memory, per process, a fixed one-minute window):
  120 requests a minute to every route except `/health` and `/health/ready`, and on top of
  that 20 sends a minute (`POST /sessions/:id/messages`; a repeated send is a send and counts
  too). Over a budget the answer is 429 problem details with code `rate_limited` and
  `Retry-After`. IPv6 addresses are grouped by /64; each budget keeps counters for up to
  100,000 addresses (the least recently seen are dropped first). With `CORS_ORIGINS` set,
  OPTIONS requests are not counted: CORS answers them first. The counters restart with the
  process.
- **Client address.** Without `TRUST_PROXY` it is the socket's address and `X-Forwarded-For`
  is ignored. With `TRUST_PROXY` (IPs or CIDR ranges only, none shorter than an IPv4 /8, an
  IPv6 /16 or, IPv4-mapped, a /104, so that no list can trust every address), a request from
  a listed proxy is keyed by the nearest `X-Forwarded-For` address that is not itself a listed
  proxy, read from the right; the leftmost value, which any client can write, never decides,
  and a socket that is not listed cannot supply a chain. **The public deployment
  ([#14](https://github.com/shaun0457/llm-chat-backend/issues/14)) runs with `TRUST_PROXY` unset for now,
  so every client behind the platform's proxy shares one budget** (the proxy's address): one
  heavy user can rate-limit everyone. Setting it needs the platform's
  documented ingress addresses; client-IP attribution on the deployment is not verified yet
  ([#25](https://github.com/shaun0457/llm-chat-backend/issues/25)).
- **Capacity limits**: at most 8 answers at a time in the process and 4 per provider, each
  over its limit answered at once with 503 ([Limits](#limits)).
- **Request bounds**: bodies up to 128 KiB, 30 s to send a whole request (stalled headers or
  a stalled body are cut with 408 within 33 s; responses, event streams and JSON waits are
  never cut), 10 s per database statement so no request waits forever behind a lock.
- **Security headers** from `@fastify/helmet` on every routed response, problem details,
  429s and event streams included (an error raised before routing, such as an undecodable
  URL, is answered without hooks, so without these headers, CORS or rate limits): a Content-Security-Policy of `'self'` (the API documentation at `/docs`
  loads only its own assets, so it still works; `upgrade-insecure-requests` is left out so it
  also works over plain HTTP), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, HSTS and the
  cross-origin isolation headers.
- **CORS** only for the origins in `CORS_ORIGINS` (or `*`); unset, no CORS headers are sent
  and browsers on other origins cannot read responses. Credentials are never allowed (none
  are used), and `Location`, `Retry-After`, `Preference-Applied` and `x-request-id` are
  exposed to scripts.
- **No server-side request forgery**: provider base URLs come only from server
  configuration; clients choose a provider id, never a URL.
- **API keys** never reach the database, logs or responses
  ([Providers and API keys](#providers-and-api-keys)); upstream error text is scrubbed of keys,
  bearer tokens and provider account identifiers before it is stored, returned or logged.
- **Internal services**: PostgreSQL and Ollama are reachable only on the compose networks.

Known gaps: one address may still hold every generation slot within its send budget, waiting
JSON requests are bounded only by the send budget, and an operator key (if one is set) can be
spent by any client. `/health/ready` is not rate limited (so a platform health check is
never throttled) and queries the database on every call. A client holding a large IPv6 prefix
gets one budget per /64, and enough addresses can push other addresses' counters out of the
store. See [What I would do next](#what-i-would-do-next).

**How authentication would be added.** First an API key per client (sent as a bearer token,
stored hashed), later JWTs from an identity provider. Sessions get an `owner_id` column set at
creation; every session-scoped query filters by it, so another owner's session answers 404
exactly like a missing one. Rate limits, capacity and retention then key on the owner instead
of the address, with per-owner quotas.

## Data retention

With `RETENTION_DAYS` set (the public deployment,
[#14](https://github.com/shaun0457/llm-chat-backend/issues/14), sets `7`), the API deletes every
session whose last activity (`lastActivityAt`: creation or the last message) is older than that many days,
with all its messages. Locally it is unset and nothing is ever deleted.

- It runs inside the API process every `RETENTION_INTERVAL_MS` (one hour by default) once the
  server listens, and stops when the server shuts down. One run at a time; a failed run is
  logged and the next one tries again. Each run logs how many sessions it deleted, skipped
  and could not delete; one that fails is passed over and retried by the next run. A
  shutdown ends a run after its current session, while running answers are stopped at the
  same time.
- A run takes its cutoff from the database clock, then walks the candidates oldest first in
  batches of 100 and deletes each through the same function as `DELETE /sessions/:id`. That
  function locks the session and checks its activity again, so a session that received a
  message after it was selected is skipped, not deleted.
- Deleting a session (by a client or by retention) also stops its running answer as soon as
  the delete has committed: the generation is aborted and writes nothing more. The delete
  waits for it to end, at most `TERMINAL_STATEMENT_TIMEOUT_MS` + 0.5 s (a write may still be
  in flight), so its capacity slot is normally free when the delete returns. Streams
  following it end without a final event.
- A deleted session cannot be recovered; there is no soft delete or backup in the API.

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

Integration tests need Docker; `pnpm test` runs at most two integration test files at a time
to keep memory low on a laptop (unit tests run first, unrestricted).

### Testing approach

Tests check external behaviour: status codes, headers, bodies, and rows as the API returns them.
They do not assert on internal calls, map contents or private state. A few boundary
observations are allowed because some guarantees can only be seen there: the fake provider
records the requests it receives (to check what context a turn sent), read-only database
queries check that no column holds an API key, the crash-recovery tests insert the
`generating` row a crashed process would have left behind, and one idempotency test inserts,
in a transaction it holds open, the turn a concurrent send to another session would insert.
Another adds a trigger to its own test database that fails every insert of one id as a
unique violation, as a send that keeps colliding would, to check the bound on re-runs. One
replay test lets an answer finish only once the job registry was asked for its job, the
moment a JSON send starts waiting for it; it observes that lookup but asserts nothing on it.

| Layer            | Where                    | What it covers                                                                                                                                                                                                                  |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit             | `test/unit`, `test/lint` | Pure pieces: configuration, catalog, `Prefer` parsing, context assembly, cursors, the scrubber, deadline arithmetic, timeout races, the terminal-write budget, shutdown timing, the OpenAPI file; the dependency-direction rule |
| Adapter contract | `test/adapters`          | `OpenAiCompatibleProvider` against an msw-mocked upstream API                                                                                                                                                                   |
| Integration      | `test/integration`       | Nearly every behaviour, through HTTP: `buildApp()` and `inject()` against a real PostgreSQL 17, with a fake LLM provider; event streams over a real socket (`test/helpers/sse-client.ts`) where timing matters                  |
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
caps answers at 1024 tokens (reasoning included), creates an `nvidia` session and asks one
question through `POST /sessions/:id/messages` (JSON, `Prefer: wait=150`), then once more as an
event stream (`Accept: text/event-stream`), which must end with `done`. It passes only with a
completed, non-empty answer each way. In a second session it sends "My name is Ada" and then
asks for the name, and the second answer must contain "Ada", which shows the first turn reached
the model as history. It prints just the answers and their usage, and fails if a response or
the container logs (which must not be empty) contain a key-shaped string. It runs after the
adapter job, so the two never call NVIDIA at the same time. Neither job is a required check.

**Against a real local model.** The `ollama` limit is an integration test with a fake
provider registered as `ollama` (`test/integration/ollama-limit.test.ts`), and the adapter's
wiring for it (base URL, the placeholder key `no-key`, the catalog's output limit) is tested
against msw. A real Ollama runs only in the `local-llm` workflow
([Local model](#local-model-ollama)); the smoke script that workflow runs has its own
integration test against the app on a real socket.

**Not tested on purpose.** The quality of real model answers (the live checks prove the path,
not the content); mutation testing; load and performance; running more than one API process,
which is out of scope. A response-conformance test against the OpenAPI document and
property-based tests are listed under [What I would do next](#what-i-would-do-next).

CI runs the same commands plus a container build-and-start check, a migration drift check, an
OpenAPI drift check, a `docker compose` smoke test, the `local-llm` check (when it applies),
a production dependency audit, a gitleaks
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

**Abuse protection, next steps** (see [Security considerations](#security-considerations)):

- A per-address cap on active generations, or a capacity check before the admission
  transaction: today one address can hold every generation slot within its send budget.
- A per-model "caller must bring a key" flag, so an operator key cannot be spent by anyone.
- Looking a repeated send's id up before taking the session lock, so replays cost less.
- A shared rate-limit store (e.g. Redis) once more than one instance runs.

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
