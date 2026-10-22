import { describe, expect, it } from "vitest";

import { type AppConfig, ConfigError, loadConfig } from "../../src/config.js";
import { DEFAULT_MODEL_CATALOG_PATH } from "../../src/paths.js";

const DATABASE_URL = "postgres://app:pw@db.internal:5432/app";

function configError(env: Record<string, string>): ConfigError {
  try {
    loadConfig(env);
  } catch (caught) {
    if (caught instanceof ConfigError) {
      return caught;
    }
    throw caught;
  }
  throw new Error("expected a ConfigError");
}

describe("loadConfig", () => {
  it("applies defaults when only DATABASE_URL is set", () => {
    expect(loadConfig({ DATABASE_URL })).toEqual({
      port: 3000,
      host: "0.0.0.0",
      logLevel: "info",
      nodeEnv: "production",
      databaseUrl: DATABASE_URL,
      modelCatalogPath: DEFAULT_MODEL_CATALOG_PATH,
      providersEnabled: ["demo"],
      defaultProvider: "demo",
      defaultModel: undefined,
      defaultSystemPrompt: undefined,
      flushIntervalMs: 1000,
      demoDelayMs: 50,
      jsonDefaultWaitMs: 30_000,
      jsonMaxWaitMs: 195_000,
      generationDeadlineMs: 180_000,
      terminalStatementTimeoutMs: 3_000,
      terminalWriteBudgetMs: 10_000,
      reclaimGraceMs: 50_000,
      staleThresholdMs: 240_000,
      maxActiveGenerations: 8,
      maxActivePerProvider: 4,
      nvidiaBaseUrl: "https://integrate.api.nvidia.com/v1",
      operatorKeys: {},
    });
  });

  it("reads explicit values", () => {
    const config = loadConfig({
      PORT: "8080",
      HOST: "127.0.0.1",
      LOG_LEVEL: "debug",
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://localhost/chat",
      MODEL_CATALOG_PATH: "/etc/chat/models.json",
      PROVIDERS_ENABLED: "demo, nvidia ,ollama",
      DEFAULT_PROVIDER: "nvidia",
      DEFAULT_MODEL: "some/model",
      DEFAULT_SYSTEM_PROMPT: "You are terse.",
      FLUSH_INTERVAL_MS: "250",
      DEMO_DELAY_MS: "0",
      JSON_DEFAULT_WAIT_MS: "0",
      JSON_MAX_WAIT_MS: "20000",
      GENERATION_DEADLINE_MS: "60000",
      TERMINAL_STATEMENT_TIMEOUT_MS: "400",
      TERMINAL_WRITE_BUDGET_MS: "2000",
      RECLAIM_GRACE_MS: "1500",
      MAX_ACTIVE_GENERATIONS: "16",
      MAX_ACTIVE_PER_PROVIDER: "3",
      NVIDIA_BASE_URL: "http://nim.internal:8000/v1",
      NVIDIA_API_KEY: "operator-key-1",
    });

    expect(config).toEqual({
      port: 8080,
      host: "127.0.0.1",
      logLevel: "debug",
      nodeEnv: "test",
      databaseUrl: "postgresql://localhost/chat",
      modelCatalogPath: "/etc/chat/models.json",
      providersEnabled: ["demo", "nvidia", "ollama"],
      defaultProvider: "nvidia",
      defaultModel: "some/model",
      defaultSystemPrompt: "You are terse.",
      flushIntervalMs: 250,
      demoDelayMs: 0,
      jsonDefaultWaitMs: 0,
      jsonMaxWaitMs: 20_000,
      generationDeadlineMs: 60_000,
      terminalStatementTimeoutMs: 400,
      terminalWriteBudgetMs: 2_000,
      reclaimGraceMs: 1_500,
      staleThresholdMs: 63_500,
      maxActiveGenerations: 16,
      maxActivePerProvider: 3,
      nvidiaBaseUrl: "http://nim.internal:8000/v1",
      operatorKeys: { nvidia: "operator-key-1" },
    });
  });

  it("takes <PROVIDER>_API_KEY for enabled providers only", () => {
    const config = loadConfig({
      DATABASE_URL,
      PROVIDERS_ENABLED: "demo,local-llm",
      LOCAL_LLM_API_KEY: "local-key",
      NVIDIA_API_KEY: "not-enabled",
    });

    expect(config.operatorKeys).toEqual({ "local-llm": "local-key" });
  });

  it.each(["has space", "x".repeat(513), "café"])(
    "rejects an operator key that is not 1-512 visible ASCII characters, without echoing it",
    (key) => {
      const error = configError({ DATABASE_URL, PROVIDERS_ENABLED: "nvidia", NVIDIA_API_KEY: key });

      expect(error.message).toContain("NVIDIA_API_KEY");
      expect(error.message).not.toContain(key);
    },
  );

  it("rejects a NVIDIA_BASE_URL with credentials in it, without echoing them", () => {
    const error = configError({
      DATABASE_URL,
      NVIDIA_BASE_URL: "https://user:pw0rd@nim.internal/v1",
    });

    expect(error.message).toContain("NVIDIA_BASE_URL");
    expect(error.message).not.toContain("pw0rd");
  });

  it.each(["ftp://nim.internal/v1", "not a url"])(
    "rejects a NVIDIA_BASE_URL that is not an http(s) URL: %s",
    (url) => {
      expect(configError({ DATABASE_URL, NVIDIA_BASE_URL: url }).message).toContain(
        "NVIDIA_BASE_URL",
      );
    },
  );

  it("requires DATABASE_URL", () => {
    expect(configError({}).message).toContain("DATABASE_URL");
  });

  it("rejects a DATABASE_URL that is not a PostgreSQL URL, without echoing it", () => {
    const { message } = configError({ DATABASE_URL: "mysql://app:s3cret@db/app" });

    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain("s3cret");
  });

  it("rejects a PROVIDERS_ENABLED list without any provider", () => {
    expect(configError({ DATABASE_URL, PROVIDERS_ENABLED: " , ," }).message).toContain(
      "PROVIDERS_ENABLED",
    );
  });

  it("rejects an invalid PORT, naming the key but not the value", () => {
    const { message } = configError({ DATABASE_URL, PORT: "abc" });

    expect(message).toContain("PORT");
    expect(message).not.toContain("abc");
  });

  it.each([
    ["FLUSH_INTERVAL_MS", "0"],
    ["FLUSH_INTERVAL_MS", "1.5"],
    ["DEMO_DELAY_MS", "-1"],
    ["DEFAULT_SYSTEM_PROMPT", "x".repeat(8001)],
    ["JSON_DEFAULT_WAIT_MS", "-1"],
    ["JSON_DEFAULT_WAIT_MS", "0.5"],
    ["JSON_MAX_WAIT_MS", "-1"],
    ["JSON_MAX_WAIT_MS", "600001"],
    ["GENERATION_DEADLINE_MS", "0"],
    ["GENERATION_DEADLINE_MS", "-1"],
    ["GENERATION_DEADLINE_MS", "1.5"],
    ["GENERATION_DEADLINE_MS", "3600001"],
    ["TERMINAL_STATEMENT_TIMEOUT_MS", "0"],
    ["TERMINAL_STATEMENT_TIMEOUT_MS", "-3000"],
    ["TERMINAL_WRITE_BUDGET_MS", "0"],
    ["TERMINAL_WRITE_BUDGET_MS", "-1"],
    ["RECLAIM_GRACE_MS", "0"],
    ["RECLAIM_GRACE_MS", "-50000"],
  ])("rejects %s=%s", (key, value) => {
    expect(configError({ DATABASE_URL, [key]: value }).message).toContain(key);
  });

  it("rejects a default JSON wait above the maximum, naming both keys", () => {
    const { message } = configError({ DATABASE_URL, JSON_MAX_WAIT_MS: "20000" });

    expect(message).toContain("JSON_DEFAULT_WAIT_MS");
    expect(message).toContain("JSON_MAX_WAIT_MS");
    // Only the maximum was set: say where the other value came from.
    expect(message).toContain("default 30000");
  });

  it("accepts a default JSON wait equal to the maximum", () => {
    expect(
      loadConfig({ DATABASE_URL, JSON_DEFAULT_WAIT_MS: "5000", JSON_MAX_WAIT_MS: "5000" }),
    ).toMatchObject({ jsonDefaultWaitMs: 5_000, jsonMaxWaitMs: 5_000 });
  });

  it("rejects a reclaim grace that a live job could outlast after its deadline and budget", () => {
    // After its deadline a live job may still wait one statement timeout for a flush before
    // its terminal budget (read-back included); reclaim must not fail it while it does, and
    // a second of slack covers late timers.
    const load = (): AppConfig =>
      loadConfig({ DATABASE_URL, TERMINAL_STATEMENT_TIMEOUT_MS: "3000", RECLAIM_GRACE_MS: "3999" });

    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/RECLAIM_GRACE_MS/);
    expect(load).toThrow(/TERMINAL_STATEMENT_TIMEOUT_MS/);
  });

  it("accepts a reclaim grace of the statement timeout plus one second", () => {
    expect(
      loadConfig({ DATABASE_URL, TERMINAL_STATEMENT_TIMEOUT_MS: "3000", RECLAIM_GRACE_MS: "4000" }),
    ).toMatchObject({ reclaimGraceMs: 4_000 });
  });

  it.each([
    ["MAX_ACTIVE_GENERATIONS", "0"],
    ["MAX_ACTIVE_GENERATIONS", "1.5"],
    ["MAX_ACTIVE_PER_PROVIDER", "0"],
    ["MAX_ACTIVE_PER_PROVIDER", "-1"],
  ])("rejects %s=%s: a capacity limit is a positive whole number", (key, value) => {
    expect(() => loadConfig({ DATABASE_URL, [key]: value })).toThrow(key);
  });

  it("lists every invalid key", () => {
    expect(() => loadConfig({ DATABASE_URL, PORT: "70000", LOG_LEVEL: "loud" })).toThrow(
      /PORT[\s\S]*LOG_LEVEL|LOG_LEVEL[\s\S]*PORT/,
    );
  });

  it("treats empty or blank values as unset instead of coercing them", () => {
    expect(
      loadConfig({ DATABASE_URL, PORT: "", HOST: " ", LOG_LEVEL: "", PROVIDERS_ENABLED: "" }),
    ).toMatchObject({
      port: 3000,
      host: "0.0.0.0",
      logLevel: "info",
      providersEnabled: ["demo"],
    });
  });

  it("returns a frozen object", () => {
    const config = loadConfig({ DATABASE_URL });

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.providersEnabled)).toBe(true);
  });
});
