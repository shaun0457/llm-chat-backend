import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../../src/config.js";
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
    });
  });

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
