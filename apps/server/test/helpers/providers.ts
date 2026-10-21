import { type ModelCatalog, parseCatalog } from "../../src/llm/catalog.js";
import { type ProviderRegistry, createRegistry } from "../../src/llm/registry.js";

/**
 * Three catalogued providers: "demo" (keyless, default), "other" (needs a key, two models) and
 * "off" (catalogued but not enabled). `defaults` replaces DEFAULT_PROVIDER / DEFAULT_MODEL.
 */
export function testProviders(
  defaults: { defaultProvider: string; defaultModel: string | undefined } = {
    defaultProvider: "demo",
    defaultModel: undefined,
  },
): { catalog: ModelCatalog; registry: ProviderRegistry } {
  const catalog = parseCatalog(
    {
      providers: {
        demo: {
          defaultModel: "demo",
          requiresKey: false,
          models: [{ id: "demo", contextWindow: 8192, maxOutputTokens: 1024 }],
        },
        other: {
          defaultModel: "o-large",
          requiresKey: true,
          maxConcurrency: 2,
          models: [
            { id: "o-small", contextWindow: 4096, maxOutputTokens: 512 },
            { id: "o-large", contextWindow: 32768, maxOutputTokens: 4096 },
          ],
        },
        off: {
          defaultModel: "off-1",
          requiresKey: false,
          models: [{ id: "off-1", contextWindow: 4096, maxOutputTokens: 512 }],
        },
      },
    },
    "test catalog",
  );
  const registry = createRegistry(catalog, {
    providersEnabled: ["demo", "other"],
    ...defaults,
  });
  return { catalog, registry };
}
