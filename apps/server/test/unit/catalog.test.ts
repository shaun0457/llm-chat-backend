import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConfigError } from "../../src/config.js";
import { CatalogError, loadCatalog, parseCatalog } from "../../src/llm/catalog.js";
import { DemoProvider } from "../../src/llm/demo.js";
import { createRegistry } from "../../src/llm/registry.js";
import { DEFAULT_MODEL_CATALOG_PATH } from "../../src/paths.js";

const demo = {
  defaultModel: "demo",
  requiresKey: false,
  models: [{ id: "demo", contextWindow: 8192, maxOutputTokens: 1024 }],
};

function catalogError(input: unknown): CatalogError {
  try {
    parseCatalog(input, "catalog.json");
  } catch (caught) {
    if (caught instanceof CatalogError) {
      return caught;
    }
    throw caught;
  }
  throw new Error("expected a CatalogError");
}

describe("model catalog", () => {
  it("ships nemotron-3-ultra as the only NVIDIA model, which passed the live check (#36)", () => {
    // Re-run the live-llm workflow before adding a model here.
    const catalog = loadCatalog(DEFAULT_MODEL_CATALOG_PATH);

    expect(catalog.provider("nvidia")).toMatchObject({
      requiresKey: true,
      defaultModel: "nvidia/nemotron-3-ultra-550b-a55b",
    });
    expect(catalog.provider("nvidia")?.models.map((model) => model.id)).toEqual([
      "nvidia/nemotron-3-ultra-550b-a55b",
    ]);
  });

  it("ships the keyless ollama provider with one small model and a limit of 2 (#11)", () => {
    // Re-run the CI local-llm job before changing the model or its limits.
    const catalog = loadCatalog(DEFAULT_MODEL_CATALOG_PATH);

    expect(catalog.provider("ollama")).toEqual({
      requiresKey: false,
      defaultModel: "qwen2.5:0.5b",
      maxConcurrency: 2,
      models: [{ id: "qwen2.5:0.5b", contextWindow: 4096, maxOutputTokens: 512 }],
    });
  });

  it("ships a default catalog with the keyless demo provider", () => {
    const catalog = loadCatalog(DEFAULT_MODEL_CATALOG_PATH);

    expect(catalog.provider("demo")).toMatchObject({ requiresKey: false, defaultModel: "demo" });
    expect(catalog.find("demo", "demo")).toEqual({
      id: "demo",
      contextWindow: expect.any(Number),
      maxOutputTokens: expect.any(Number),
    });
  });

  it("looks models up per provider", () => {
    const catalog = parseCatalog({ providers: { demo } }, "catalog.json");

    expect(catalog.find("demo", "demo")?.maxOutputTokens).toBe(1024);
    expect(catalog.find("demo", "other")).toBeUndefined();
    expect(catalog.find("other", "demo")).toBeUndefined();
    expect(catalog.provider("other")).toBeUndefined();
  });

  it("names the file and the path of an invalid entry", () => {
    const { message } = catalogError({
      providers: { demo: { ...demo, models: [{ id: "demo", contextWindow: "big" }] } },
    });

    expect(message).toContain("catalog.json");
    expect(message).toContain("providers.demo.models.0.contextWindow");
    expect(message).toContain("providers.demo.models.0.maxOutputTokens");
  });

  it("rejects a default model the provider does not list", () => {
    expect(
      catalogError({ providers: { demo: { ...demo, defaultModel: "nope" } } }).message,
    ).toContain("providers.demo.defaultModel");
  });

  it("rejects a model listed twice", () => {
    const models = [...demo.models, ...demo.models];

    expect(catalogError({ providers: { demo: { ...demo, models } } }).message).toContain(
      "providers.demo.models.1.id",
    );
  });

  it("rejects a max output that does not fit the context window", () => {
    const models = [{ id: "demo", contextWindow: 1000, maxOutputTokens: 1000 }];

    expect(catalogError({ providers: { demo: { ...demo, models } } }).message).toContain(
      "providers.demo.models.0.maxOutputTokens",
    );
  });

  it("rejects unknown fields such as a base URL, which belongs to server configuration", () => {
    expect(
      catalogError({ providers: { demo: { ...demo, baseUrl: "http://169.254.169.254" } } }).message,
    ).toContain("providers.demo");
  });

  describe("loading a file", () => {
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "catalog-"));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("names a file that cannot be read", () => {
      const path = join(dir, "missing.json");

      expect(() => loadCatalog(path)).toThrow(CatalogError);
      expect(() => loadCatalog(path)).toThrow(path);
    });

    it("names a file that is not JSON", async () => {
      const path = join(dir, "broken.json");
      await writeFile(path, "{ providers: ");

      expect(() => loadCatalog(path)).toThrow(path);
    });
  });
});

describe("provider registry", () => {
  const catalog = parseCatalog(
    {
      providers: {
        demo,
        other: {
          defaultModel: "o-large",
          requiresKey: true,
          models: [
            { id: "o-small", contextWindow: 4096, maxOutputTokens: 512 },
            { id: "o-large", contextWindow: 32768, maxOutputTokens: 4096 },
          ],
        },
      },
    },
    "catalog.json",
  );

  function registryError(settings: Parameters<typeof createRegistry>[1]): ConfigError {
    try {
      createRegistry(catalog, settings);
    } catch (caught) {
      if (caught instanceof ConfigError) {
        return caught;
      }
      throw caught;
    }
    throw new Error("expected a ConfigError");
  }

  it("fails when an enabled provider is not in the catalog, naming it", () => {
    const { message } = registryError({
      providersEnabled: ["demo", "ghost"],
      defaultProvider: "demo",
      defaultModel: undefined,
    });

    expect(message).toContain("PROVIDERS_ENABLED");
    expect(message).toContain("ghost");
  });

  it("fails when the default provider is not enabled", () => {
    const { message } = registryError({
      providersEnabled: ["demo"],
      defaultProvider: "other",
      defaultModel: undefined,
    });

    expect(message).toContain("DEFAULT_PROVIDER");
  });

  it("fails when the default model is not in the default provider's catalog", () => {
    const { message } = registryError({
      providersEnabled: ["demo", "other"],
      defaultProvider: "other",
      defaultModel: "demo",
    });

    expect(message).toContain("DEFAULT_MODEL");
  });

  it("defaults to the default provider's own default model", () => {
    const registry = createRegistry(catalog, {
      providersEnabled: ["demo", "other"],
      defaultProvider: "other",
      defaultModel: undefined,
    });

    expect(registry.defaults).toEqual({ provider: "other", model: "o-large" });
  });

  it("serves the adapter of an enabled provider only", () => {
    const demo = new DemoProvider({ delayMs: 0 });
    const other = new DemoProvider({ delayMs: 0 });
    const registry = createRegistry(
      catalog,
      { providersEnabled: ["demo"], defaultProvider: "demo", defaultModel: undefined },
      { demo, other },
    );

    expect(registry.adapter("demo")).toBe(demo);
    expect(registry.adapter("other")).toBeUndefined();
    expect(registry.adapter("toString")).toBeUndefined();
  });

  it("has no adapter for an enabled provider without an implementation", () => {
    const registry = createRegistry(catalog, {
      providersEnabled: ["demo", "other"],
      defaultProvider: "demo",
      defaultModel: undefined,
    });

    expect(registry.adapter("other")).toBeUndefined();
  });
});
