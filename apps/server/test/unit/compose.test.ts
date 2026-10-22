import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { shutdownTimeoutMs } from "../../src/server.js";
import { POSTGRES_IMAGE } from "../postgres-image.js";

const compose = readFileSync(new URL("../../../../docker-compose.yml", import.meta.url), "utf8");

describe("docker-compose.yml", () => {
  it("runs the PostgreSQL image the tests run against", () => {
    expect(compose).toContain(`image: ${POSTGRES_IMAGE}\n`);
  });

  it("lets the api shut down gracefully before Docker kills it", () => {
    const api = compose.slice(compose.indexOf("\n  api:\n"));
    const grace = /\n {4}stop_grace_period: (\d+)s\n/.exec(api)?.[1];
    const timeoutMs = shutdownTimeoutMs(loadConfig({ DATABASE_URL: "postgres://x@db/x" }));

    expect(Number(grace) * 1_000).toBeGreaterThan(timeoutMs);
  });
});
