# LLM Chat Backend

A multi-session chat API in front of large language models, built with Fastify, TypeScript and
PostgreSQL.

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

Check it:

```sh
curl localhost:3000/health/ready
curl -X POST localhost:3000/sessions -H 'content-type: application/json' -d '{"title":"Hello"}'
curl localhost:3000/sessions
curl -X POST localhost:3000/sessions/<id>/messages -H 'content-type: application/json' \
  -d '{"content":"Hello"}'   # the demo provider answers without any API key
```

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
exceed `JSON_MAX_WAIT_MS`.

| Variable                | Default                      | Meaning                                                                                         |
| ----------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | (required)                   | `postgres://` or `postgresql://` connection URL                                                 |
| `PORT`                  | `3000`                       | Listening port                                                                                  |
| `HOST`                  | `0.0.0.0`                    | Listening address                                                                               |
| `LOG_LEVEL`             | `info`                       | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`                                  |
| `NODE_ENV`              | `production`                 | `development`, `test` or `production`                                                           |
| `MODEL_CATALOG_PATH`    | bundled `config/models.json` | Model catalog file (see below)                                                                  |
| `PROVIDERS_ENABLED`     | `demo`                       | Comma-separated provider ids; each must be in the catalog                                       |
| `DEFAULT_PROVIDER`      | `demo`                       | Provider for sessions created without one; must be enabled                                      |
| `DEFAULT_MODEL`         | the provider's default       | Model for sessions created without one, or with only `DEFAULT_PROVIDER`; must be in the catalog |
| `DEFAULT_SYSTEM_PROMPT` | (none)                       | System prompt for turns of sessions without their own (up to 8,000 characters)                  |
| `FLUSH_INTERVAL_MS`     | `1000`                       | How often a generating answer's partial text is written to the database (10–60,000)             |
| `DEMO_DELAY_MS`         | `50`                         | Pause between the demo provider's chunks (0–10,000)                                             |
| `JSON_DEFAULT_WAIT_MS`  | `30000`                      | How long a JSON send waits for its answer without `Prefer: wait` (0–600,000)                    |
| `JSON_MAX_WAIT_MS`      | `195000`                     | The longest a JSON send ever waits (0–600,000); keep it below your proxy's timeout              |

The model catalog lists, per provider, whether it needs an API key, its default model and its
models with context window and maximum output tokens. Unknown fields are rejected, so provider
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

| Endpoint                          | Behaviour                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /sessions`                  | 201 + `Location`. Provider/model default to the configuration                                                                                                                                                                                                                                                                                                                          |
| `GET /sessions`                   | `?limit=` 1–100 (default 20), `?cursor=` from the previous `nextCursor`                                                                                                                                                                                                                                                                                                                |
| `GET /sessions/:id`               | 404 `session_not_found` if missing, 400 for a malformed id                                                                                                                                                                                                                                                                                                                             |
| `PATCH /sessions/:id`             | Any of `title`, `provider`, `model`, `systemPrompt`; `null` clears title or prompt                                                                                                                                                                                                                                                                                                     |
| `DELETE /sessions/:id`            | 204, then 404                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /sessions/:id/messages`     | `{ "content" }` (1–16,000 characters, not blank; unknown fields are a 400). Waits a bounded time (see below): 200 `{ userMessage, assistantMessage }`, 502 problem details with both messages when it failed, 202 with both messages while it is still generating. 409 `session_busy` while the session's previous answer is generating; 503 `server_busy` while the server shuts down |
| `GET /sessions/:id/messages`      | `?limit=` 1–200 (default 50), `?before=` a message id of this session; newest page first, ascending `seq` within a page                                                                                                                                                                                                                                                                |
| `GET /sessions/:id/messages/:mid` | One message, including the partial text of an answer being generated; `Cache-Control: no-store`; 404 `message_not_found` outside this session                                                                                                                                                                                                                                          |
| `GET /providers`                  | Enabled providers, whether they need a key, their catalogued models                                                                                                                                                                                                                                                                                                                    |
| `GET /health`                     | Liveness, no dependencies                                                                                                                                                                                                                                                                                                                                                              |
| `GET /health/ready`               | 200 when the database answers and its migrations match this build                                                                                                                                                                                                                                                                                                                      |

A message list page holds the newest `limit` messages below `before` (or the newest overall),
in ascending `seq`. `nextBefore` is the id of the page's first item when older messages exist,
otherwise `null`; pass it as `before` for the next page. A `before` that is not a message of
this session is 404 `message_not_found`.

Provider and model resolve the same way on create and update: both given → as given; provider
only → that provider's default model; model only → the current (or default) provider. An
unknown or disabled provider is 422 `provider_unavailable`; a model outside that provider's
catalog is 422 `model_not_supported`.

The session list is ordered by most recent activity, then id, and pages with an opaque keyset
cursor. It is a **live list, not a snapshot**: a session that gets new activity while you page
moves to the first page, so clients refresh from the first page. Pages have no gaps or
duplicates while the ordering keys do not change. Timestamps are ISO-8601 UTC with microsecond
precision, the database's own precision.

## Architecture: sending a message

```text
POST /sessions/:id/messages
  │  validate the body (no database access)
  ▼
admission transaction ── lock the session row (404)
  │                      resolve its provider and model (422)
  │                      a turn still generating? (409 session_busy)
  │                      reserve capacity
  │                      insert user + generating assistant, advance next_seq,
  │                      bump last_activity_at, title an untitled session
  ▼ commit
job (in process) ── context: system prompt + earlier completed turns + the new message
  │                provider.stream() → deltas into the message's event bus
  │                every FLUSH_INTERVAL_MS: fenced UPDATE of the partial text
  │                finish → fenced UPDATE to completed; error → failed (llm_upstream_error)
  ▼ finally: release capacity, leave the job map, close the bus
JSON response ── waits for the job's end or the effective wait, whichever is first,
                 then reads both rows: 200, 502 problem details, or 202 + Location
```

Every rule that must survive a restart or a second process lives in PostgreSQL: the row lock,
the partial unique index on generating turns, and the `attempt` fence on every generation
write. Memory only holds the stream buffer, the abort controller and capacity counters. See
[ADR 0003](docs/adr/0003-single-process-db-truth.md).

A turn's context is the frozen system prompt, then every completed turn with a lower `seq`
(user and assistant text), then the new message. Turns whose answer failed or is still being
generated are left out whole. An untitled session takes its title from the first non-blank
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
(unless the server shuts down), and polling `Location` returns the message's current state (partial text while generating), never
from a cache, until its status is `completed` or `failed`. `respond-async` means "do not wait",
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

Always handle 202, even with a long `wait`: the server may shut down meanwhile, and a proxy in
front of it may time out before the configured maximum (lower `JSON_MAX_WAIT_MS` below it).
`Preference-Applied` reports which preferences were honoured; it promises neither completion
nor an exact wait. See [ADR 0004](docs/adr/0004-async-request-reply.md).

## Test

```sh
pnpm lint:ci     # ESLint without --fix, zero warnings allowed
pnpm typecheck   # tsc --noEmit
pnpm test:unit   # unit and lint tests only; no Docker needed
pnpm test        # everything; Docker must be running (testcontainers)
```

Integration tests start one PostgreSQL 17 container per run, migrate a template database once,
and give every test file its own copy, so files run in parallel without seeing each other's
rows. They drive the app in-process through `buildApp()` and `inject()` against that real
database; process tests run the built server and migration entry as child processes. CI runs
the same commands plus a container build-and-start check, a migration drift check, a
`docker compose` smoke test, a production dependency audit, a gitleaks secret scan and a
commit-message check. CodeQL runs once the repository is public; code scanning on private
repositories needs a paid license.

## API documentation

- Interactive docs: `GET /docs`
- OpenAPI 3.1 document: `GET /openapi.json`

Both are generated from the same zod schemas that validate requests. Errors use RFC 9457
problem details (`application/problem+json`) with a stable `code` field.

Decisions are recorded in [`docs/adr`](docs/adr).
