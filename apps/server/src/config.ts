import { isIP } from "node:net";
import { z } from "zod";

import { API_KEY_PATTERN } from "./credentials/api-key.js";
import { DEFAULT_MODEL_CATALOG_PATH } from "./paths.js";

const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof logLevels)[number];

/** "demo, nvidia" → ["demo", "nvidia"]; blank items are dropped. */
const commaList = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )
  .pipe(z.array(z.string()).min(1));

const MAX_JSON_WAIT_MS = 600_000;
const DEFAULT_JSON_WAIT_MS = 30_000;
/** Upper bound of the generation and reclaim timings: one hour, far below setTimeout's limit. */
const MAX_TIMING_MS = 3_600_000;
/** Slack that RECLAIM_GRACE_MS must keep on top of the statement timeout (late timers). */
const RECLAIM_SLACK_MS = 1_000;

/** A positive whole number of milliseconds; zero or less would disable the safety net. */
const timingMs = (fallback: number) =>
  z.coerce.number().int().min(1).max(MAX_TIMING_MS).default(fallback);
/** At least one active generation; zero would refuse every send. */
const capacityLimit = (fallback: number) =>
  z.coerce.number().int().min(1).max(10_000).default(fallback);
const DEFAULT_NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
/** Ollama's own default address; docker compose points it at the `ollama` service instead. */
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";

/** An OpenAI-compatible API's base URL: http(s), without credentials in it. */
const providerBaseUrl = (fallback: string) =>
  z
    .url({ protocol: /^https?$/ })
    .refine((value) => {
      // Runs after a failed URL check too: only judge what parses.
      const url = URL.canParse(value) ? new URL(value) : undefined;
      return url === undefined || (url.username === "" && url.password === "");
    }, "must not contain credentials")
    .default(fallback);

/** One trusted proxy: an IPv4/IPv6 address, or one in CIDR notation (`10.0.0.0/8`). */
function isIpOrCidr(value: string): boolean {
  const [address = "", prefix, ...rest] = value.split("/");
  const version = isIP(address);
  if (version === 0 || rest.length > 0) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  const bits = Number(prefix);
  return /^\d{1,3}$/.test(prefix) && bits <= (version === 4 ? 32 : 128);
}

/**
 * Trusted proxies as addresses and CIDR ranges only. Fastify would also take a hop count
 * (which makes it ignore forwarding headers), `true` (which makes the client-supplied leftmost
 * X-Forwarded-For value the client address) and names such as `loopback`; all are rejected.
 */
const trustProxyList = commaList.refine(
  (items) => items.every(isIpOrCidr),
  "must be a comma-separated list of IP addresses or CIDR ranges",
);

/** `*` alone, or http(s) origins (scheme, host, optional port; no path, query or user). */
const corsOriginList = commaList.refine(
  (items) =>
    (items.length === 1 && items[0] === "*") ||
    items.every((item) => {
      const url = URL.canParse(item) ? new URL(item) : undefined;
      return /^https?:$/.test(url?.protocol ?? "") && url?.origin === item;
    }),
  "must be * alone or a comma-separated list of http(s) origins",
);

const MAX_RETENTION_INTERVAL_MS = 86_400_000;
const DEFAULT_RETENTION_INTERVAL_MS = 3_600_000;
const perMinuteLimit = (fallback: number) =>
  z.coerce.number().int().min(1).max(1_000_000).default(fallback);

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(logLevels).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  MODEL_CATALOG_PATH: z.string().min(1).default(DEFAULT_MODEL_CATALOG_PATH),
  PROVIDERS_ENABLED: commaList.default(["demo"]),
  DEFAULT_PROVIDER: z.string().min(1).default("demo"),
  DEFAULT_MODEL: z.string().min(1).optional(),
  DEFAULT_SYSTEM_PROMPT: z
    .string()
    .max(8000)
    .refine((value) => !value.includes("\u0000"))
    .optional(),
  FLUSH_INTERVAL_MS: z.coerce.number().int().min(10).max(60_000).default(1000),
  DEMO_DELAY_MS: z.coerce.number().int().min(0).max(10_000).default(50),
  // Capped well below setTimeout's 2^31-1 ms limit, past which a timer fires at once.
  JSON_DEFAULT_WAIT_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_JSON_WAIT_MS)
    .default(DEFAULT_JSON_WAIT_MS),
  JSON_MAX_WAIT_MS: z.coerce.number().int().min(0).max(MAX_JSON_WAIT_MS).default(195_000),
  GENERATION_DEADLINE_MS: timingMs(180_000),
  TERMINAL_STATEMENT_TIMEOUT_MS: timingMs(3_000),
  TERMINAL_WRITE_BUDGET_MS: timingMs(10_000),
  RECLAIM_GRACE_MS: timingMs(50_000),
  SSE_PING_INTERVAL_MS: z.coerce.number().int().min(100).max(MAX_TIMING_MS).default(15_000),
  // Bytes waiting for a slow client before its stream is closed, 16 KiB to 64 MiB. A frame
  // written to an empty buffer always goes out, so a single large event never trips it.
  SSE_BUFFER_LIMIT_BYTES: z.coerce.number().int().min(16_384).max(67_108_864).default(262_144),
  MAX_ACTIVE_GENERATIONS: capacityLimit(8),
  MAX_ACTIVE_PER_PROVIDER: capacityLimit(4),
  // Server configuration only: clients can never choose where a provider call goes. Checked
  // below, and only for enabled providers.
  NVIDIA_BASE_URL: z.string().optional(),
  OLLAMA_BASE_URL: z.string().optional(),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(MAX_TIMING_MS).default(10_000),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(MAX_JSON_WAIT_MS).default(30_000),
  RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).optional(),
  RETENTION_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(10)
    .max(MAX_RETENTION_INTERVAL_MS)
    .default(DEFAULT_RETENTION_INTERVAL_MS),
  RATE_LIMIT_GENERAL_PER_MIN: perMinuteLimit(120),
  RATE_LIMIT_SEND_PER_MIN: perMinuteLimit(20),
  TRUST_PROXY: trustProxyList.optional(),
  CORS_ORIGINS: corsOriginList.optional(),
});

/** The provider base URLs; a provider's own is validated only when it is enabled. */
const BASE_URLS = [
  { provider: "nvidia", key: "NVIDIA_BASE_URL", fallback: DEFAULT_NVIDIA_BASE_URL },
  { provider: "ollama", key: "OLLAMA_BASE_URL", fallback: DEFAULT_OLLAMA_BASE_URL },
] as const;

/** Throws (naming the key, never its value) when an enabled provider's base URL is invalid. */
function readBaseUrls(
  providers: readonly string[],
  env: Record<string, string>,
): Record<(typeof BASE_URLS)[number]["provider"], string> {
  const urls = { nvidia: DEFAULT_NVIDIA_BASE_URL, ollama: DEFAULT_OLLAMA_BASE_URL };
  const problems: Array<{ key: string; reason: string }> = [];
  for (const { provider, key, fallback } of BASE_URLS) {
    if (!providers.includes(provider)) {
      continue;
    }
    const result = providerBaseUrl(fallback).safeParse(
      Object.hasOwn(env, key) ? env[key] : undefined,
    );
    if (result.success) {
      urls[provider] = result.data;
    } else {
      problems.push(...result.error.issues.map((issue) => ({ key, reason: issue.code })));
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
  return urls;
}

/** Holds the database password and operator API keys: never log it. */
export type AppConfig = Readonly<{
  port: number;
  host: string;
  logLevel: LogLevel;
  nodeEnv: "development" | "test" | "production";
  databaseUrl: string;
  modelCatalogPath: string;
  providersEnabled: readonly string[];
  defaultProvider: string;
  /** Unset: the default provider's own default model. */
  defaultModel: string | undefined;
  /** Frozen into turns of sessions without their own system prompt. Unset: no system message. */
  defaultSystemPrompt: string | undefined;
  /** How often a generating answer's partial text is written to the database. */
  flushIntervalMs: number;
  /** Pause between the demo provider's chunks. */
  demoDelayMs: number;
  /** How long a JSON send waits for its answer without a `Prefer: wait`. */
  jsonDefaultWaitMs: number;
  /** The longest a JSON send ever waits; keep it below the proxy's response timeout. */
  jsonMaxWaitMs: number;
  /** Hard limit of one generation attempt, counted from just before its admitting insert. */
  generationDeadlineMs: number;
  /** Limit of each statement of a terminal write (completed, failed). */
  terminalStatementTimeoutMs: number;
  /** Limit of a whole terminal write, retries and backoff included. */
  terminalWriteBudgetMs: number;
  /**
   * Margin on top of deadline and terminal budget before a generating row counts as dead;
   * at least the statement timeout plus one second.
   */
  reclaimGraceMs: number;
  /**
   * deadline + terminal budget + grace: a row still generating this long after `started_at`
   * (database clock) has no live job and is failed as `interrupted` by stale reclaim.
   */
  staleThresholdMs: number;
  /** How often a quiet event stream gets a `: ping` comment. */
  ssePingIntervalMs: number;
  /**
   * Bytes an event stream may have waiting to be sent to its client; a frame that would go
   * beyond closes that connection (a slow consumer), never the generation.
   */
  sseBufferLimitBytes: number;
  /** Active generations in this process at most; further sends get 503 server_busy. */
  maxActiveGenerations: number;
  /**
   * Active generations per provider at most, unless its catalog entry sets maxConcurrency;
   * further sends to that provider get 503 provider_busy.
   */
  maxActivePerProvider: number;
  /** Where the nvidia provider's OpenAI-compatible API lives. */
  nvidiaBaseUrl: string;
  /** Where the ollama provider's OpenAI-compatible API lives (a local Ollama server). */
  ollamaBaseUrl: string;
  /** `<PROVIDER>_API_KEY` of each enabled provider that has one, by provider id. Secrets. */
  operatorKeys: Readonly<Record<string, string>>;
  /**
   * The pool's default limit of one statement (lock waits included), so a request stuck
   * behind a lock fails instead of waiting forever. Jobs set their own, shorter limits.
   */
  dbStatementTimeoutMs: number;
  /**
   * How long a client may take to send a whole request (headers and body). It never limits
   * a response, however long it streams or waits.
   */
  requestTimeoutMs: number;
  /** Sessions inactive for longer are deleted by the retention interval; unset: never. */
  retentionDays: number | undefined;
  /** How often retention runs while it is enabled. */
  retentionIntervalMs: number;
  /** Requests per minute per client IP to every route except the health checks. */
  rateLimitGeneralPerMin: number;
  /** Sends per minute per client IP, on top of the general limit. */
  rateLimitSendPerMin: number;
  /**
   * Proxies (IPs or CIDR ranges) whose X-Forwarded-For is believed; unset: the client IP is
   * the socket's address.
   */
  trustProxy: readonly string[] | undefined;
  /** Origins that receive CORS headers: `["*"]` for any; empty for none (no CORS headers). */
  corsOrigins: readonly string[];
}>;

/** Names the invalid keys and why; never includes the values, which may be secrets. */
export class ConfigError extends Error {
  constructor(readonly problems: ReadonlyArray<{ key: string; reason: string }>) {
    super(
      `Invalid configuration: ${problems.map(({ key, reason }) => `${key} (${reason})`).join(", ")}`,
    );
    this.name = "ConfigError";
  }
}

/** `PORT=` (empty or blank) means unset; otherwise zod would coerce "" to port 0. */
function withoutBlankValues(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[1].trim().length > 0,
    ),
  );
}

/** "local-llm" → "LOCAL_LLM_API_KEY". */
export function operatorKeyName(providerId: string): string {
  return `${providerId.toUpperCase().replaceAll("-", "_")}_API_KEY`;
}

/** Throws (naming the key, never its value) when an operator key is malformed. */
function readOperatorKeys(
  providers: readonly string[],
  env: Record<string, string>,
): Readonly<Record<string, string>> {
  const keys: Record<string, string> = {};
  const problems: Array<{ key: string; reason: string }> = [];
  for (const provider of providers) {
    const name = operatorKeyName(provider);
    const value = Object.hasOwn(env, name) ? env[name] : undefined;
    if (value === undefined) {
      continue;
    }
    if (API_KEY_PATTERN.test(value)) {
      keys[provider] = value;
    } else {
      problems.push({ key: name, reason: "must be 1-512 visible ASCII characters" });
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
  return Object.freeze(keys);
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const present = withoutBlankValues(env);
  const result = envSchema.safeParse(present);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => ({
        key: issue.path.join("."),
        reason: issue.code,
      })),
    );
  }

  const parsed = result.data;
  if (parsed.JSON_DEFAULT_WAIT_MS > parsed.JSON_MAX_WAIT_MS) {
    throw new ConfigError([
      {
        key: "JSON_DEFAULT_WAIT_MS",
        reason: `greater than JSON_MAX_WAIT_MS; lower both (default ${DEFAULT_JSON_WAIT_MS})`,
      },
    ]);
  }
  // Past its deadline a live job may still wait one statement timeout for a flush in flight
  // before its terminal budget (which includes reading its final state back) starts; reclaim
  // must not beat it, with a second of slack for late timers and a busy event loop.
  if (parsed.RECLAIM_GRACE_MS < parsed.TERMINAL_STATEMENT_TIMEOUT_MS + RECLAIM_SLACK_MS) {
    throw new ConfigError([
      {
        key: "RECLAIM_GRACE_MS",
        reason: `must be at least TERMINAL_STATEMENT_TIMEOUT_MS + ${RECLAIM_SLACK_MS}`,
      },
    ]);
  }
  const providersEnabled = Object.freeze([...new Set(parsed.PROVIDERS_ENABLED)]);
  const baseUrls = readBaseUrls(providersEnabled, present);
  return Object.freeze({
    port: parsed.PORT,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    nodeEnv: parsed.NODE_ENV,
    databaseUrl: parsed.DATABASE_URL,
    modelCatalogPath: parsed.MODEL_CATALOG_PATH,
    providersEnabled,
    defaultProvider: parsed.DEFAULT_PROVIDER,
    defaultModel: parsed.DEFAULT_MODEL,
    defaultSystemPrompt: parsed.DEFAULT_SYSTEM_PROMPT,
    flushIntervalMs: parsed.FLUSH_INTERVAL_MS,
    demoDelayMs: parsed.DEMO_DELAY_MS,
    jsonDefaultWaitMs: parsed.JSON_DEFAULT_WAIT_MS,
    jsonMaxWaitMs: parsed.JSON_MAX_WAIT_MS,
    generationDeadlineMs: parsed.GENERATION_DEADLINE_MS,
    terminalStatementTimeoutMs: parsed.TERMINAL_STATEMENT_TIMEOUT_MS,
    terminalWriteBudgetMs: parsed.TERMINAL_WRITE_BUDGET_MS,
    reclaimGraceMs: parsed.RECLAIM_GRACE_MS,
    staleThresholdMs:
      parsed.GENERATION_DEADLINE_MS + parsed.TERMINAL_WRITE_BUDGET_MS + parsed.RECLAIM_GRACE_MS,
    ssePingIntervalMs: parsed.SSE_PING_INTERVAL_MS,
    sseBufferLimitBytes: parsed.SSE_BUFFER_LIMIT_BYTES,
    maxActiveGenerations: parsed.MAX_ACTIVE_GENERATIONS,
    maxActivePerProvider: parsed.MAX_ACTIVE_PER_PROVIDER,
    nvidiaBaseUrl: baseUrls.nvidia,
    ollamaBaseUrl: baseUrls.ollama,
    operatorKeys: readOperatorKeys(providersEnabled, present),
    dbStatementTimeoutMs: parsed.DB_STATEMENT_TIMEOUT_MS,
    requestTimeoutMs: parsed.REQUEST_TIMEOUT_MS,
    retentionDays: parsed.RETENTION_DAYS,
    retentionIntervalMs: parsed.RETENTION_INTERVAL_MS,
    rateLimitGeneralPerMin: parsed.RATE_LIMIT_GENERAL_PER_MIN,
    rateLimitSendPerMin: parsed.RATE_LIMIT_SEND_PER_MIN,
    trustProxy:
      parsed.TRUST_PROXY === undefined ? undefined : Object.freeze([...parsed.TRUST_PROXY]),
    corsOrigins: Object.freeze([...(parsed.CORS_ORIGINS ?? [])]),
  });
}
