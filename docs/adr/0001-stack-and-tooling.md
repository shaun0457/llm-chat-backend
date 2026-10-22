# ADR 0001: Stack and tooling

- Status: accepted
- Date: 2026-10-21

## Context

The service is a single-process HTTP API in a pnpm + Turborepo monorepo that already builds
with tsup (ESM) and lints with ESLint 8. Every later feature needs the same foundations: an app
factory tests can drive without a network, validated configuration, one error format, API docs
that cannot drift from validation, safe logs, a container image and a CI gate.

## Options considered

- **HTTP framework:** Express (no schema-first validation or typed routes without extra
  layers), NestJS (decorators and DI container are heavy for a small service), Hono (good
  types, smaller ecosystem for OpenAPI/Swagger UI on Node). **Fastify** wins: schema-driven
  validation and serialization, `inject()` for in-process tests, built-in pino logging.
- **Test runner:** Jest (ESM + TypeScript needs extra transforms) vs **Vitest** (native ESM
  and TypeScript, same `expect` API).
- **Lint:** migrating to ESLint 9 flat config would rewrite the inherited config for no feature
  gain; **ESLint 8.57** is kept and only typescript-eslint is upgraded (see V1).

## Decision

Fastify 5 with `fastify-type-provider-zod`: one zod schema per route drives validation, the
handler's types and the OpenAPI document (`@fastify/swagger`, Swagger UI at `/docs`,
`/openapi.json`). `buildApp(deps)` returns a non-listening instance; only `server.ts` listens.
Errors are RFC 9457 problem details with a stable `code`. Logs are pino JSON with request ids
and credential-header redaction. Versions are pinned exactly:

| Package                   | Version     | Package                           | Version                      |
| ------------------------- | ----------- | --------------------------------- | ---------------------------- |
| fastify                   | 5.12.7      | vitest                            | 4.1.12                       |
| fastify-type-provider-zod | 7.0.0       | typescript                        | 5.9.3                        |
| zod                       | 4.6.7       | @typescript-eslint/\*             | 8.72.0                       |
| @fastify/swagger          | 9.9.2       | eslint                            | 8.57.1                       |
| @fastify/swagger-ui       | 6.1.2       | eslint-import-resolver-typescript | 4.4.5                        |
| tsup                      | 8.3.0 (dev) | node image                        | 22.23.3-slim (digest pinned) |
| @fastify/rate-limit       | 11.2.1      |                                   |                              |
| @fastify/helmet           | 13.1.2      |                                   |                              |
| @fastify/cors             | 11.3.1      |                                   |                              |

## Verification findings

- **V1 TypeScript vs typescript-eslint:** typescript-eslint 5.62 supports TypeScript < 5.2,
  but the lockfile already had 5.9.3. typescript-eslint 8.72 supports TypeScript >= 4.8.4 and
  < 6.1.0 and ESLint ^8.57, so it was upgraded with ESLint 8 kept. TypeScript 7 (npm
  `latest`) is outside that range; 5.9.3 is pinned. `lint:ci` prints no unsupported warning.
- **V2 zod provider:** provider 7.x needs zod >= 4.2 (uses `encode`/`decode`) and Fastify
  ^5.5; 7.0.0 with zod 4.6.7 is the newest compatible pair.
- **V3 server timeouts:** Fastify defaults are `connectionTimeout` 0 (no socket inactivity
  timeout), `requestTimeout` 0 and `keepAliveTimeout` 72 s; Node's `headersTimeout` (60 s)
  and `requestTimeout` only bound _receiving_ a request. A real-server test with these timeouts
  scaled to 100–300 ms shows a 1.5 s response still completes, while a short socket timeout
  does cut it. Nothing ends a 195 s JSON wait, so no options are set; a test asserts the app
  keeps socket and request timeouts at 0. Slow-request protection belongs to the proxy/#12.
- **V4 CodeQL:** code scanning on private repositories needs a GitHub Code Security license.
  The CodeQL job runs only when the repository is public.
- **V5 gitleaks:** `gitleaks-action` needs no license key for personal-account repositories;
  v3.0.0 is used, pinned by commit SHA like every third-party action.
- **V6 `pnpm deploy --prod`:** pnpm 9 produces a self-contained folder (`dist/`,
  `package.json`, production `node_modules`, 35 MB). `"files": ["dist"]` is required because
  the package `.gitignore` excludes `dist/` from the copy.
- **V7 bundling:** tsup bundles only `src/` and leaves every `dependencies` entry as an
  external import, so Swagger UI's static files and pino load from `node_modules` at runtime.
  Verified in the runtime image: `/docs` and all seven referenced assets return 200. No pino
  transports are used; development pretty-printing pipes output to `pino-pretty`.

## Consequences

- Later tickets extend `AppDeps` and the config schema instead of adding globals.
- `import/no-restricted-paths` enforces routes → service → port ← adapter. It needs
  `eslint-import-resolver-typescript`: without it, `./x.js` imports of `.ts` files do not
  resolve and the rule silently skips them. The adapter zone is a deny-list; every new
  adapter file must be added to it.
- The image runs as the non-root `node` user and contains no build or test tooling.
- ESLint 8 is end-of-life; moving to ESLint 9 flat config is a separate, mechanical change.
