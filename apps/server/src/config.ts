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
  });
}
