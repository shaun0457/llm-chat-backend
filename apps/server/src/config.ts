import { z } from "zod";

const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof logLevels)[number];

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(logLevels).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
});

export type AppConfig = Readonly<{
  port: number;
  host: string;
  logLevel: LogLevel;
  nodeEnv: "development" | "test" | "production";
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
  });
}
