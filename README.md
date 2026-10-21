# LLM Chat Backend

A multi-session chat API in front of large language models, built with Fastify and TypeScript.

## Prerequisites

- Node.js 22 (the image uses 22.23.3)
- pnpm 9 (the pinned version is enabled with `corepack enable`)
- Docker, for the container image

## Run locally

```sh
pnpm install
pnpm build
pnpm start          # http://localhost:3000
```

`pnpm dev` rebuilds on change. Configuration comes from environment variables, validated at
startup; an invalid value stops the process and names the variable (never its value).

| Variable    | Default      | Meaning                                                        |
| ----------- | ------------ | -------------------------------------------------------------- |
| `PORT`      | `3000`       | Listening port                                                 |
| `HOST`      | `0.0.0.0`    | Listening address                                              |
| `LOG_LEVEL` | `info`       | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |
| `NODE_ENV`  | `production` | `development`, `test` or `production`                          |

Logs are JSON. For readable output, pipe them through the bundled formatter:

```sh
pnpm --filter server start | pnpm --filter server exec pino-pretty
```

With Docker:

```sh
docker build -t llm-chat-backend .
docker run --rm -p 3000:3000 llm-chat-backend
```

## Test

```sh
pnpm lint:ci     # ESLint without --fix, zero warnings allowed
pnpm typecheck   # tsc --noEmit
pnpm test        # Vitest; builds the server once for the process tests
```

Tests drive the app in-process through `buildApp()` and `inject()`, start the built server as a
child process for startup and shutdown, and lint in-memory source to prove the
dependency-direction rule. CI runs the same commands plus a container build-and-start check,
a production dependency audit, a gitleaks secret scan and a commit-message check. CodeQL runs
once the repository is public; code scanning on private repositories needs a paid license.

## API documentation

- Interactive docs: `GET /docs`
- OpenAPI 3.1 document: `GET /openapi.json`

Both are generated from the same zod schemas that validate requests. Errors use RFC 9457
problem details (`application/problem+json`) with a stable `code` field.

Decisions are recorded in [`docs/adr`](docs/adr).
