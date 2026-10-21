import { z } from "zod";

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
  JSON_DEFAULT_WAIT_MS: z.coerce.number().int().min(0).max(MAX_JSON_WAIT_MS).default(30_000),
  JSON_MAX_WAIT_MS: z.coerce.number().int().min(0).max(MAX_JSON_WAIT_MS).default(195_000),
});

/** Holds the database password: never log it. */
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

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const result = envSchema.safeParse(withoutBlankValues(env));
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
      { key: "JSON_DEFAULT_WAIT_MS", reason: "greater than JSON_MAX_WAIT_MS" },
    ]);
  }
  return Object.freeze({
    port: parsed.PORT,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    nodeEnv: parsed.NODE_ENV,
    databaseUrl: parsed.DATABASE_URL,
    modelCatalogPath: parsed.MODEL_CATALOG_PATH,
    providersEnabled: Object.freeze([...new Set(parsed.PROVIDERS_ENABLED)]),
    defaultProvider: parsed.DEFAULT_PROVIDER,
    defaultModel: parsed.DEFAULT_MODEL,
    defaultSystemPrompt: parsed.DEFAULT_SYSTEM_PROMPT,
    flushIntervalMs: parsed.FLUSH_INTERVAL_MS,
    demoDelayMs: parsed.DEMO_DELAY_MS,
    jsonDefaultWaitMs: parsed.JSON_DEFAULT_WAIT_MS,
    jsonMaxWaitMs: parsed.JSON_MAX_WAIT_MS,
  });
}
