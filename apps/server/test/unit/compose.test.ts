import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { loadCatalog } from "../../src/llm/catalog.js";
import { DEFAULT_MODEL_CATALOG_PATH } from "../../src/paths.js";
import { shutdownTimeoutMs } from "../../src/server.js";
import { POSTGRES_IMAGE } from "../postgres-image.js";

const compose = readFileSync(new URL("../../../../docker-compose.yml", import.meta.url), "utf8");

/** One service's block of docker-compose.yml: from its name to the next top-level entry. */
function service(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  if (start === -1) {
    throw new Error(`docker-compose.yml has no service ${name}`);
  }
  const rest = compose.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n|\n[a-z][\w-]*:\n/);
  return end === -1 ? rest : rest.slice(0, end + 2);
}

/** `KEY: value` of a service's environment, with `${VAR:-default}` resolved to the default. */
function environment(block: string, key: string): string | undefined {
  const value = new RegExp(`\\n {6}${key}: (.+)\\n`).exec(block)?.[1];
  return value?.replace(/^\$\{[A-Z_]+:-(.*)\}$/, "$1").replace(/^"(.*)"$/, "$1");
}

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

  describe("the local-llm profile", () => {
    const ollamaEntry = loadCatalog(DEFAULT_MODEL_CATALOG_PATH).provider("ollama");
    const model = ollamaEntry?.models.find((entry) => entry.id === ollamaEntry.defaultModel);

    it("runs a pinned Ollama image in the profile only, unpublished, as parallel as the catalog limit, with twice the catalogued context", () => {
      const ollama = service("ollama");

      expect(ollama).toMatch(/\n {4}profiles: \["local-llm"\]\n/);
      expect(ollama).toMatch(/\n {4}image: ollama\/ollama:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}\n/);
      expect(ollama).not.toContain("ports:");
      expect(environment(ollama, "OLLAMA_NUM_PARALLEL")).toBe(String(ollamaEntry?.maxConcurrency));
      // Ollama cuts a prompt longer than its context silently, without an error; the headroom
      // absorbs where the history budget's token estimate is too low.
      expect(Number(environment(ollama, "OLLAMA_CONTEXT_LENGTH"))).toBe(
        2 * (model?.contextWindow ?? NaN),
      );
      expect(ollama).toContain("healthcheck:");
    });

    it("pulls the catalog's default ollama model once Ollama is healthy, in the profile only", () => {
      const pull = service("ollama-pull");

      expect(pull).toMatch(/\n {4}profiles: \["local-llm"\]\n/);
      expect(pull).toContain(`"pull", "${ollamaEntry?.defaultModel}"`);
      expect(pull).toMatch(/\n {6}ollama:\n {8}condition: service_healthy\n/);
      expect(pull).toMatch(/\n {4}restart: "no"\n/);
    });

    it("starts the api only after the pull completed, and still without the profile", () => {
      const api = service("api");

      expect(api).toMatch(
        /\n {6}ollama-pull:\n {8}condition: service_completed_successfully\n {8}required: false\n/,
      );
    });

    it("keeps postgres off the network ollama is on; only the api joins both", () => {
      const networks = (block: string): string[] =>
        /\n {4}networks: \[([^\]]*)\]\n/
          .exec(block)?.[1]
          ?.split(",")
          .map((name) => name.trim()) ?? ["default"];

      expect(networks(service("ollama"))).toEqual(["llm"]);
      expect(networks(service("ollama-pull"))).toEqual(["llm"]);
      expect(networks(service("api"))).toEqual(["default", "llm"]);
      expect(networks(service("postgres"))).toEqual(["default"]);
      expect(networks(service("migrate"))).toEqual(["default"]);
    });

    it("points the api at the ollama service but keeps demo the only provider enabled by default", () => {
      const api = service("api");

      expect(environment(api, "OLLAMA_BASE_URL")).toBe("http://ollama:11434/v1");
      expect(environment(api, "PROVIDERS_ENABLED")).toBe("demo");
      expect(environment(api, "DEFAULT_PROVIDER")).toBe("demo");
    });
  });
});
