# LLM Chat Backend

A chat backend with multiple conversation sessions, written in TypeScript on Node.js with Fastify
and PostgreSQL. A session keeps its messages; each new message goes to an LLM together with the
earlier turns, and the answer comes back as JSON or as a stream of server-sent events. Two real
LLM providers, NVIDIA's hosted API and a small local model in Ollama, go through one shared
OpenAI-compatible adapter behind a common `LlmProvider` port; a keyless `demo` provider makes the
API usable without either. Based on [nhwang0/llm-chat-backend](https://github.com/nhwang0/llm-chat-backend)
at [`8bf820d`](https://github.com/nhwang0/llm-chat-backend/tree/8bf820d).

Both LLM bonuses are included. Beyond the requirements, most of the work went into one
problem: an LLM answer can take minutes, and in that time a client may retry, the process may
die, and the caller's own API key sits in memory. For that the service adds safe retries with
client ids, a deadline and crash recovery per answer, fenced writes, use of the caller's key
without storing it, and concurrency and rate limits. Each decision has a longer record in
[`docs/adr`](docs/adr/README.md).

Required sections: [architecture](#architecture), [how to run](#run-it), [tests](#tests),
[schema](#database), [queries](#how-the-data-model-serves-each-query),
[build vs reuse](#build-vs-reuse), [API docs](#api-documentation), [deployment](#deployment).

How I read the open points of the assignment:

- No authentication, as the assignment allows. Sessions are therefore global: anyone who can reach the API can read, change and delete every session.
- Deleting a session is included, and removes its messages with it.
- "Local database" means a database server started by Docker Compose next to the API, here PostgreSQL 17.
- The response format is mine to choose, so a client can wait for JSON, poll, or stream.
- Answer quality is not evaluated; the tests prove the path to the model, not what it says.

## Run it

You need Docker with Compose v2.20 or later, and `curl` and `jq` for the examples. To develop and
run the tests you also need Node.js 22 and pnpm 9 (`corepack enable`). The commands are for bash
or zsh; on Windows use WSL, or Git Bash with `jq` installed.

```sh
docker compose up --build -d    # http://localhost:3000
until curl -sf localhost:3000/health/ready >/dev/null; do sleep 1; done
```

Compose starts PostgreSQL 17, runs the migrations once, and only then starts the API. No `.env`
is needed. Without a key, sessions use the built-in `demo` provider, which answers with a fixed
sentence:

```sh
SESSION_ID=$(curl -s -X POST localhost:3000/sessions -H 'content-type: application/json' \
  -d '{"title":"Hello"}' | jq -r .id)
curl -X POST "localhost:3000/sessions/$SESSION_ID/messages" -H 'content-type: application/json' \
  -d '{"content":"Hello"}'
curl "localhost:3000/sessions/$SESSION_ID/messages"
```

To use the hosted model, copy `.env.example` to `.env`, set `PROVIDERS_ENABLED=demo,nvidia`, and
run `docker compose up -d` again. `.env.example` sets `POSTGRES_PASSWORD=change-me`, but a stack
that already ran without `.env` created its database with `chat`: set `POSTGRES_PASSWORD=chat`
in `.env`, or run `docker compose down -v` first, which deletes the data. Then either give the
server a key (`NVIDIA_API_KEY=...`) or send your own with each message in the `X-LLM-Api-Key`
header, which is used for that one answer only:

```sh
SESSION_ID=$(curl -s -X POST localhost:3000/sessions -H 'content-type: application/json' \
  -d '{"provider":"nvidia"}' | jq -r .id)
curl -X POST "localhost:3000/sessions/$SESSION_ID/messages" -H 'content-type: application/json' \
  -H "X-LLM-Api-Key: ${MY_NVIDIA_KEY:?}" -d '{"content":"What is the capital of France?"}'
```

Without Docker you need your own PostgreSQL 17. Only Docker Compose reads `.env`; a local run
takes its settings from the environment:

```sh
export DATABASE_URL=postgres://user:password@localhost:5432/chat
pnpm install && pnpm build
pnpm --filter server migrate   # the API itself never migrates
pnpm --filter server start     # http://localhost:3000
```

Settings are validated at startup by `apps/server/src/config.ts`, which lists every one with its
limits. `.env.example` holds the ones compose passes on; a local run also uses `PORT` and `HOST`.

### Local model (bonus 2.1)

```sh
docker compose --env-file local-llm.env up --build -d
until curl -sf localhost:3000/health/ready >/dev/null; do sleep 5; done
SESSION_ID=$(curl -s -X POST localhost:3000/sessions -H 'content-type: application/json' \
  -d '{"provider":"ollama"}' | jq -r .id)
curl -X POST "localhost:3000/sessions/$SESSION_ID/messages" -H 'content-type: application/json' \
  -H 'Prefer: wait=120' -d '{"content":"What is the capital of France?"}'
docker compose --env-file local-llm.env down
```

This adds Ollama with `qwen2.5:0.5b` (about 400 MB), CPU only. `local-llm.env` sets
`PROVIDERS_ENABLED=demo,ollama`, so `nvidia` is off in this stack. To keep your `.env` settings
as well, pass `--env-file .env` before `--env-file local-llm.env`, to both `up` and `down`. A CPU answer can take longer
than the default 30 s wait, hence `Prefer: wait=120`. The first start is slow: the pinned
`ollama/ollama:0.35.1` image is 9.37 GB because it bundles GPU runtimes, and the first `up` took
about 23 minutes on my machine (a 4-CPU Docker VM over a home connection). Later starts reuse
the image and the model volume. The default `docker compose up` does not start Ollama.

## Architecture

```mermaid
flowchart LR
  client(["API client"])
  nvidia["NVIDIA hosted API"]
  subgraph compose["docker compose"]
    migrate["migrate (one-shot)"]
    postgres[("PostgreSQL 17")]
    ollama["Ollama (optional profile)"]
    subgraph api["api: one Node process"]
      routes["Fastify routes + zod schemas"]
      services["services: admission transaction"]
      jobs["in-process generation jobs"]
      port{{"LlmProvider port"}}
    end
  end
  client -- "JSON or SSE" --> routes --> services --> jobs --> port
  port -- "OpenAI-compatible" --> nvidia
  port -. "OpenAI-compatible, no key" .-> ollama
  services -- "row lock, inserts, reads" --> postgres
  jobs -- "fenced updates" --> postgres
  migrate --> postgres
```

A send runs in two steps, so that no lock is ever held while the model is generating. First one
short transaction admits the turn: it locks the session, runs the checks (provider, key, an
answer still generating, capacity), and stores the user message with an empty assistant message
marked `generating`. After the commit, a job in the same process streams the answer from the
model, writes the text as it arrives, and stores the final state. The HTTP response either waits
for that job or streams it.

Entry points in the code:

- `apps/server/src/modules/messages/service.ts`: the admission transaction and the order of its checks.
- `apps/server/src/modules/messages/jobs.ts`: the generation job, its deadline and its final write.
- `apps/server/src/llm/port.ts` and `apps/server/src/llm/openai-compatible.ts`: what the core needs from a model, and the one adapter both providers use.
- `apps/server/src/db/schema.ts`: tables, indexes and the constraints that enforce the rules.
- `apps/server/src/modules/sessions/routes.ts`: how a route declares its schema, which also builds the API docs.

## Design decisions

| Decision                                                                    | Rejected alternative                          | What it costs                                                                                                                                                                | ADR                                                                                 |
| --------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| One process; PostgreSQL enforces the consistency rules                      | In-memory locks; a job queue with workers     | No scale-out or failover; capacity, rate limits and live streams are per process                                                                                             | [0003](docs/adr/0003-single-process-db-truth.md)                                    |
| Fastify; one zod schema per route for validation, types and OpenAPI         | Express; NestJS; Hono                         | Responses are not yet checked against the document ([#26](https://github.com/shaun0457/llm-chat-backend/issues/26)); Fastify, zod and the type provider must stay compatible | [0001](docs/adr/0001-stack-and-tooling.md)                                          |
| PostgreSQL with Drizzle; migrations as a separate step                      | Prisma or Kysely; migrating at API startup    | drizzle-kit's defaults need checking (the list index needed `NULLS FIRST`); a deploy needs a migrate step                                                                    | [0002](docs/adr/0002-postgres-drizzle-migrations.md)                                |
| JSON waits 30 s, then 202 + `Location`; or SSE                              | Always wait; always 202                       | Clients must handle 202; the only way to stop an answer is to delete its session                                                                                             | [0004](docs/adr/0004-async-request-reply.md), [0006](docs/adr/0006-sse-reattach.md) |
| A deadline per answer; dead answers failed by the next request              | Leases with heartbeats; a sweeper             | A crashed answer blocks its session until a request comes 240 s after it started; every request to one session runs one `UPDATE`                                             | [0005](docs/adr/0005-deadline-reclaim.md)                                           |
| The client may send its own message id, so a retry is never stored twice    | An `Idempotency-Key` table; dedupe by content | No id, no dedupe; content is compared exactly; "admitted once", not "the model ran once"                                                                                     | [0007](docs/adr/0007-idempotency-client-ids.md)                                     |
| One LLM port; an SDK client per call with the caller's key                  | A shared client per provider; stored keys     | The caller sends the key with every message, and a restart loses it                                                                                                          | [0008](docs/adr/0008-llm-port-byok.md)                                              |
| The model's reasoning is dropped, so the API stays the same for every model | Storing or streaming it                       | A client cannot show the model's reasoning                                                                                                                                   | [0008](docs/adr/0008-llm-port-byok.md)                                              |

Why PostgreSQL even for one process: a deploy briefly runs the old and the new process side by
side, and the consistency rules must hold across both ([ADR 0003](docs/adr/0003-single-process-db-truth.md)).
Drizzle keeps the SQL visible and types rows from the schema file, and drizzle-kit writes plain
SQL migrations that are reviewed and committed; Prisma brings its own migration engine and
binary, and Kysely leaves migrations to be written by hand.

### Where the consistency rules live

A chat backend must not run two answers at once in one session, and a slow or dead answer must
not overwrite a newer state. Keeping that in memory (a mutex per session, a map of running
turns) is simple, but it is correct only while exactly one process exists, and a restart or a
deploy overlap breaks it. So PostgreSQL decides: a row lock orders writes to a session, a
partial unique index allows one `generating` answer per session, and every write by a job must
find the answer still `generating` at the `attempt` it started, so a late writer changes
nothing. The generations themselves run in the API process (see
[Build vs reuse](#build-vs-reuse) for why not a queue).

Today every answer has attempt 1, because a failed answer cannot be retried in place yet
([#13](https://github.com/shaun0457/llm-chat-backend/issues/13)); once retries exist, the
attempt number keeps an older attempt from overwriting a newer one.

### How a slow answer reaches the client

Holding the request open until the answer is done lets a proxy timeout decide the outcome;
answering 202 every time makes a quick answer cost two round trips. A JSON send therefore waits a
bounded time, which the client can change with the standard `Prefer` header (RFC 7240), and gets
202 with a `Location` to poll if the answer is not done. A client that wants the typing effect
asks for an event stream. Either way the answer is generated and stored even if the client goes
away, so a user who closes the tab still pays for it, and a client can follow it again later
from the text so far.

### What happens when the process dies

A lost answer is marked failed and the user asks again; the generation is not resumed. An
attempt has a 180 s deadline, storing its final state has a 10 s budget, and a 50 s safety
margin on top makes 240 s (all configurable): longer than any live job can run, so a row still
`generating` after that has no job behind it. Correctness still rests on the fenced `UPDATE`
above, not on the timing. Nothing reclaims on a timer: a request to that session first fails
stale answers as `interrupted`, by the database clock (a send that is then refused rolls this
back with the rest of its transaction). A graceful stop tries
to fail the answers in progress as `cancelled`; one that misses the 10 s budget is reclaimed
like a crash. Leases with heartbeats would notice a crash sooner, but only pay off when another
worker can take over.

## Sessions and messages

| Endpoint                                 | What it does                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `POST /sessions`                         | Create a session; provider and model default to the configuration                            |
| `GET /sessions`                          | List sessions, most recent activity first, 20 per page (up to 100) with a cursor             |
| `GET /sessions/:id`                      | Read one session                                                                             |
| `PATCH /sessions/:id`                    | Change the title, provider, model or system prompt for later turns                           |
| `DELETE /sessions/:id`                   | Delete the session and its messages; its running answers are aborted once the delete commits |
| `POST /sessions/:id/messages`            | Send a message and get the answer (details below)                                            |
| `GET /sessions/:id/messages`             | Message history, newest page first, 50 per page (up to 200)                                  |
| `GET /sessions/:id/messages/:mid`        | One message, including the partial text of an answer still being generated                   |
| `GET /sessions/:id/messages/:mid/events` | Follow an answer as an event stream, from the text so far                                    |
| `GET /providers`                         | Enabled providers and their models                                                           |

The send takes `{ "id"?, "content", "provider"?, "model"? }`:

- Content must be 1 to 16,000 characters and not blank; an unknown field is a 400.
- `provider` and `model` override the session's pair for this one turn.
- A JSON send returns 200 with both messages, 502 if the answer failed, or 202 with a `Location` if it is still being generated.
- With `Accept: text/event-stream` the answer arrives as events: `message.created`, then `delta` pieces, then `done` or `error`; `message.detached` means this process cannot follow the answer, so poll the message instead. A stream can also end with no final event (for example, the session was deleted); read the message again then.
- The optional `id` makes a send safe to repeat. The same id with the same content in the same session returns the stored turn, answered like the first send (200, 502 or 202), never 409, and never calls the model again.
- Two such copies at once are ordered by the session's row lock. A repeat of a failed turn returns the same 502, so a retry with a corrected key needs a new id.
- The same id with different content, a provider or model in the request that differs from the turn's, an id used in another session, or an assistant message's id is 422 `message_id_conflict`.
- While an earlier answer in the same session is still generating, a new send gets 409 `session_busy`.

A failed answer keeps its partial text and gets a stable `errorCode`: `llm_auth_failed`,
`llm_upstream_error`, `llm_timeout`, `llm_context_overflow`, `cancelled` (the server shut down)
or `interrupted` (the process died). By default each client address may make 120 requests (the
health checks not counted) and 20 sends a minute, repeats included (429 `rate_limited` beyond
that). At most 8 answers run at a time in the process, 4 per
provider and 2 for the local Ollama model (503 beyond that); both answers carry `Retry-After`.
The history sent to the model is cut, oldest whole turns first, to fit the model's context window.

## LLM integration

| Provider | Key | Model                                | Enable with                     |
| -------- | --- | ------------------------------------ | ------------------------------- |
| `demo`   | no  | a fixed sentence, for trying the API | on by default                   |
| `nvidia` | yes | `nvidia/nemotron-3-ultra-550b-a55b`  | `PROVIDERS_ENABLED=demo,nvidia` |
| `ollama` | no  | `qwen2.5:0.5b`, local, CPU only      | `--env-file local-llm.env`      |

NVIDIA and Ollama both speak the OpenAI API, so both go through one adapter built on the official
`openai` SDK, which already parses the streamed chunks, retries 429 and 5xx with backoff and
enforces timeouts. For Ollama only the base URL, the timeout (120 s instead of 60 s, since a CPU
model can need over a minute before its first token) and the retry count (none) differ.

I picked the NVIDIA model with a benchmark of the five models the key could use, 20 calls each
([ADR 0008](docs/adr/0008-llm-port-byok.md)): `nemotron-3-ultra` answered every time, with the
first answer token after a median of 2.0 s (p95 10.6 s) and the whole answer after a median of
6.7 s (p95 19.4 s). It is a reasoning model; the adapter drops the reasoning and keeps only the
answer, so it is never stored, returned, streamed or logged. An answer with no text, because the
model reasoned or used its whole output budget first, fails instead of completing empty.

For a provider that needs a key, a new turn takes the `X-LLM-Api-Key` header, else the server's
own key, else fails with 422 `llm_credential_missing`; a provider that needs no key never
receives one. The key stays in memory for that one generation (the string itself until garbage
collection). The service does not write it anywhere itself: logs redact the credential headers,
upstream error text is scrubbed of the key and of known key patterns before it is stored or
logged, and a sentinel test checks every log line, row and response on success and on upstream
errors, as JSON and as a stream. The answer text is not filtered, so a model that repeated a key
back would have it stored like any other answer.

## Database

The schema is in `apps/server/src/db/schema.ts`; migrations are generated from it and committed
under `apps/server/drizzle/`.

`sessions`

| Column                     | Type          | Why it is there                                                             |
| -------------------------- | ------------- | --------------------------------------------------------------------------- |
| `id`                       | `uuid` PK     | UUIDv7, generated by the app                                                |
| `title`, `system_prompt`   | `text` null   | Set by the user; an untitled session takes its title from the first message |
| `provider`, `model`        | `text`        | The session's default pair for new turns                                    |
| `next_seq`                 | `integer`     | The per-session message counter, advanced under the row lock                |
| `last_activity_at`         | `timestamptz` | Orders the session list; moves only when a turn is added                    |
| `created_at`, `updated_at` | `timestamptz` |                                                                             |

`messages`

| Column                                                | Type                                     | Why it is there                                                                    |
| ----------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `id`                                                  | `uuid` PK                                | UUIDv7, or the client's own id, which makes a repeated send detectable             |
| `session_id`                                          | `uuid` FK                                | `ON DELETE CASCADE`, so deleting a session is one statement                        |
| `seq`                                                 | `integer`                                | Position in the session, unique per session; the only ordering key                 |
| `role`                                                | `text`                                   | `user` or `assistant`                                                              |
| `reply_to_id`                                         | `uuid` null, unique, FK to `messages.id` | The question an answer belongs to, so a turn is a pair of rows                     |
| `content`                                             | `text`                                   | Partial while generating, and kept when the answer fails                           |
| `status`                                              | `text`                                   | `generating`, `completed` or `failed`; user messages are always `completed`        |
| `attempt`                                             | `integer`                                | Fencing token, 1 for now: every write by a job must match it                       |
| `started_at`                                          | `timestamptz` null                       | When the attempt started, by the database clock; used to find dead answers         |
| `provider`, `model`, `system_prompt`                  | `text` null                              | Frozen when the turn was admitted, so later session changes do not rewrite history |
| `error_code`, `error_detail`                          | `text` null                              | A stable code and a safe description of a failure                                  |
| `prompt_tokens`, `completion_tokens`, `finish_reason` | `integer` / `text` null                  | What the provider reported                                                         |
| `latency_ms`                                          | `integer` null                           | How long the generation took, measured by the service                              |
| `created_at`, `updated_at`                            | `timestamptz`                            |                                                                                    |

Check constraints keep user rows free of assistant-only fields, and require an answer to carry
its question, start time, provider and model.

### How the data model serves each query

| Query                              | Index or constraint                                       | How                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| List sessions, most recent first   | `(last_activity_at DESC, id DESC)`                        | Keyset paging with an opaque cursor, never `OFFSET`                                                                                        |
| Read or lock one session           | primary key                                               | A send's admission, an update and a delete take `SELECT … FOR UPDATE` on the session first; a job's writes use the fenced `UPDATE` instead |
| Message history, newest page first | unique `(session_id, seq)`                                | `seq < before ORDER BY seq DESC LIMIT n + 1`, returned in ascending order                                                                  |
| One message                        | primary key                                               | Looked up together with `session_id`, so another session's message is 404                                                                  |
| A turn's context                   | unique `(session_id, seq)`                                | Newest completed turns below the new one, until the token budget is used                                                                   |
| One generating answer per session  | partial unique `(session_id) WHERE status = 'generating'` | The database enforces it, also against a race                                                                                              |
| A repeated send                    | primary key on `messages.id`                              | Ids are global, so one lookup finds it in any session                                                                                      |
| Delete a session                   | foreign key `ON DELETE CASCADE`                           | One `DELETE` removes its messages                                                                                                          |

## Tests

```sh
pnpm install
pnpm lint:ci && pnpm typecheck
pnpm test:unit   # no Docker needed
pnpm test        # everything; Docker must be running, and the first run pulls the PostgreSQL image
```

What I chose to test, in order of priority:

1. The session and message API through HTTP: status codes, bodies and headers, as a client sees them.
2. The LLM boundary from both sides: service and API tests use `FakeLlmProvider`, a scriptable fake of the provider port that can stream, stall, fail or hang; the real adapter runs against an upstream mocked with [msw](https://mswjs.io/) (reasoning fields, 401, 429 then success, timeouts).
3. The rules only a real database can prove: locks, unique indexes and fenced updates, against PostgreSQL 17 in a container (see [Build vs reuse](#build-vs-reuse)).
4. The reliability details last: deadlines and shutdown with the time limits scaled down, and crash recovery with rows whose start time is set back in the database.

The default suite never calls a real model; the Ollama tests in CI use msw and the fake. A real
Ollama runs only in the local-LLM workflow (by hand, on pushes to `main`, and on pull requests
that touch provider, catalog or compose files or carry its label). An opt-in check calls the
real NVIDIA API:
`LLM_LIVE_TESTS=1 NVIDIA_API_KEY=... pnpm --filter server exec vitest run test/adapters/nvidia-live.test.ts`.

The main design properties and their tests (files under `apps/server/test/integration/`):

| Property                                   | How it is tested                                                                                               | Test                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| One generating answer per session          | Two racing sends: one is admitted, the other gets 409 and writes nothing                                       | `messages-send`                      |
| The database enforces it too               | A second `generating` row is rejected by the partial unique index                                              | `messages-schema`                    |
| A repeat returns the same turn             | The same id and content while the turn is generating: 202 with the same turn, never 409                        | `messages-replay`                    |
| An id is admitted at most once             | The same id sent to two sessions at once: one admitted, the other 422                                          | `messages-replay`                    |
| A stale job cannot overwrite a newer state | A job finishing after its row was reclaimed, or moved to attempt 2 by the test, changes nothing                | `messages-reclaim`, `messages-flush` |
| A crashed answer is recovered              | A `generating` row left by a dead process is failed as `interrupted` on read, and the session takes a new send | `messages-reclaim`                   |
| Re-attaching to a stream loses nothing     | The text so far as a snapshot, then only the remaining deltas                                                  | `messages-events`                    |
| A key never persists                       | A sentinel key is searched for in every log line, database row and response                                    | `sentinel`                           |

Evidence, three runs on commit
[`3f5e955`](https://github.com/shaun0457/llm-chat-backend/commit/3f5e955e50d05eb5c8089e2151c954650956dcc6)
(2026-10-22):

- [CI](https://github.com/shaun0457/llm-chat-backend/actions/runs/39828633284): 820 tests in 76 files with PostgreSQL 17 in testcontainers, 818 passed and the 2 opt-in live NVIDIA tests skipped; the same run built the image and started the compose stack.
- [Live LLM check](https://github.com/shaun0457/llm-chat-backend/actions/runs/39828633328): the live tests against NVIDIA, then a JSON and a streamed answer through the running API, and a second turn that shows the first reached the model as history.
- [Local LLM check](https://github.com/shaun0457/llm-chat-backend/actions/runs/39828633330): the compose stack with a real Ollama, a streamed and a JSON answer, and the concurrency limit.

## Build vs reuse

### Reused: a real PostgreSQL in the tests

The consistency rules are a row lock, a partial unique index and fenced updates, so a test only
proves them against a database that really locks. An in-memory fake such as pg-mem has no real
locking, and a shared local database leaks state from one run into the next. The integration
tests use testcontainers to start PostgreSQL 17, the same image compose runs, and give each test
file its own copy of a migrated template database. In exchange `pnpm test` needs Docker and
takes longer; `pnpm test:unit` runs without it.

### Built: a token estimate instead of a tokenizer

The history sent with a turn has to fit the model's context window. Tokenizers differ by model,
and the two providers run different models (Nemotron on NVIDIA, Qwen on Ollama), so one tokenizer
package would be exact for at most one of them. `estimateTokens` counts one token per CJK
character and one per three other characters, plus 8 per message, and the budget keeps 10 % of
the context window free besides the output reservation. A message that cannot fit even on its
own is refused with 422 `input_too_long` and nothing is stored. The estimate for the history can
still come out low. A provider that reports the overflow fails the answer with
`llm_context_overflow`; Ollama instead drops the start of a prompt that is too long, so compose
gives it twice the catalog's context window to absorb an underestimate.

### Built: generation jobs in the API process instead of a queue

A jobs table claimed with `SKIP LOCKED`, or pg-boss, would run on the same PostgreSQL and let
workers scale out. It would also put the worker and the request waiting for its answer in
different processes: live streams would need `LISTEN/NOTIFY`, and every turn a lease renewed by
a heartbeat. In one process the job and the waiting request share memory. That leaves a single
API process, at most 8 answers at a time and no failover; with several instances I would move to
the jobs table.

## API documentation

Interactive docs are at `GET /docs` and the OpenAPI 3.1 document at `GET /openapi.json`; the same
document is in the repository as [`docs/openapi.json`](docs/openapi.json), and CI fails if it is
out of date. Errors are RFC 9457 problem details with a stable `code` field.

## Deployment

The service is not publicly deployed (bonus 7 not done). `Dockerfile` and `docker-compose.yml` are
the deployment files. To deploy it I would:

- run the image as one instance with managed PostgreSQL, `node dist/migrate.js` as the pre-deploy step, and no server API key;
- set `TRUST_PROXY` to the proxy's addresses or CIDR ranges, or every client shares one rate-limit bucket;
- give the platform a stop grace above 18 s (compose sets 20 s), so aborted answers can store their final state;
- set `JSON_MAX_WAIT_MS` below the proxy's timeout, and check that the proxy streams SSE without buffering;
- expose only `/health` publicly, since `/health/ready` queries the database and is not rate limited;
- set `RETENTION_DAYS` so anonymous sessions do not pile up, and `CORS_ORIGINS` for a browser client;
- keep `MAX_ACTIVE_GENERATIONS` below the database pool size (node-postgres' default of 10).

## Limitations and next steps

Not verified: answer quality, load, more than one API process, and SSE through a real proxy.

| Limitation                                                                                | Why, or what I would do                                                                                  |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| No authentication: anyone who can reach the API can read, change and delete every session | Not asked for; accounts and per-user ownership of sessions come before any real users                    |
| One API instance: capacity, rate limits and live streams do not scale out                 | See [Build vs reuse](#build-vs-reuse)                                                                    |
| A crashed answer blocks its session until a request comes 240 s after it started          | Follows from having no lease or sweeper                                                                  |
| A failed answer cannot be retried in place; the user sends the question again             | Retry as a new attempt of the same turn ([#13](https://github.com/shaun0457/llm-chat-backend/issues/13)) |
| A send based on stale history is accepted, so two tabs can talk over each other           | Reject it ([#23](https://github.com/shaun0457/llm-chat-backend/issues/23))                               |
| A server key can be spent by any client                                                   | A public deployment would hold no key                                                                    |
| Responses are not checked against the OpenAPI document                                    | A conformance test ([#26](https://github.com/shaun0457/llm-chat-backend/issues/26))                      |
| SSE and timeouts are unmeasured behind a real proxy                                       | Deploy and measure ([#25](https://github.com/shaun0457/llm-chat-backend/issues/25))                      |
