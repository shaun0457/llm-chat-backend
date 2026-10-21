import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("applies defaults when the environment is empty", () => {
    expect(loadConfig({})).toEqual({
      port: 3000,
      host: "0.0.0.0",
      logLevel: "info",
      nodeEnv: "production",
    });
  });

  it("reads explicit values", () => {
    const config = loadConfig({
      PORT: "8080",
      HOST: "127.0.0.1",
      LOG_LEVEL: "debug",
      NODE_ENV: "test",
    });

    expect(config).toEqual({ port: 8080, host: "127.0.0.1", logLevel: "debug", nodeEnv: "test" });
  });

  it("rejects an invalid PORT, naming the key but not the value", () => {
    let error: unknown;
    try {
      loadConfig({ PORT: "abc" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    expect(message).toContain("PORT");
    expect(message).not.toContain("abc");
  });

  it("lists every invalid key", () => {
    expect(() => loadConfig({ PORT: "70000", LOG_LEVEL: "loud" })).toThrow(
      /PORT[\s\S]*LOG_LEVEL|LOG_LEVEL[\s\S]*PORT/,
    );
  });

  it("treats empty or blank values as unset instead of coercing them", () => {
    expect(loadConfig({ PORT: "", HOST: " ", LOG_LEVEL: "" })).toMatchObject({
      port: 3000,
      host: "0.0.0.0",
      logLevel: "info",
    });
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(loadConfig({}))).toBe(true);
  });
});
