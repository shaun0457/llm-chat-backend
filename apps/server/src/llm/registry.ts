import { ConfigError } from "../config.js";
import type { ModelCatalog, ModelEntry } from "./catalog.js";
import type { LlmProvider } from "./port.js";

export type ModelPair = Readonly<{ provider: string; model: string }>;

/** What `GET /providers` shows. Never says whether an operator key is configured. */
export type ProviderInfo = Readonly<{
  id: string;
  requiresKey: boolean;
  defaultModel: string;
  models: readonly ModelEntry[];
}>;

export type PairResolution =
  | { ok: true; pair: ModelPair }
  | { ok: false; reason: "provider_unavailable" | "model_not_supported" };

export interface ProviderRegistry {
  /** The configured default provider and model; valid by construction. */
  readonly defaults: ModelPair;
  /** Enabled providers, in PROVIDERS_ENABLED order. */
  list(): readonly ProviderInfo[];
  /** An enabled provider; undefined when unknown or not enabled. */
  provider(providerId: string): ProviderInfo | undefined;
  /**
   * Fills in a requested provider/model against `base` and validates the result; session
   * create, session update and every new turn use this one rule:
   * both → as given; provider only → that provider's default model, also when it is
   * `base.provider` (omit the provider to keep `base.model`); model only → `base.provider`;
   * neither → `base`. Unknown or disabled provider → provider_unavailable; model not in that
   * provider's catalog → model_not_supported.
   */
  resolve(requested: { provider?: string; model?: string }, base: ModelPair): PairResolution;
  /** The implementation serving an enabled provider; undefined when disabled or not built. */
  adapter(providerId: string): LlmProvider | undefined;
}

export type RegistrySettings = {
  providersEnabled: readonly string[];
  defaultProvider: string;
  defaultModel: string | undefined;
};

/**
 * Throws ConfigError at startup unless every enabled provider and the default pair resolve.
 * `adapters` maps provider ids to their implementations; ids that are not enabled are ignored.
 */
export function createRegistry(
  catalog: ModelCatalog,
  settings: RegistrySettings,
  adapters: Readonly<Record<string, LlmProvider>> = {},
): ProviderRegistry {
  const enabled = new Map<string, ProviderInfo>();
  const missing: string[] = [];
  for (const id of settings.providersEnabled) {
    const entry = catalog.provider(id);
    if (entry === undefined) {
      missing.push(id);
    } else {
      const { requiresKey, defaultModel, models } = entry;
      enabled.set(id, Object.freeze({ id, requiresKey, defaultModel, models }));
    }
  }
  if (missing.length > 0) {
    throw new ConfigError([
      { key: "PROVIDERS_ENABLED", reason: `not in the model catalog: ${missing.join(", ")}` },
    ]);
  }

  const defaultProvider = enabled.get(settings.defaultProvider);
  if (defaultProvider === undefined) {
    throw new ConfigError([{ key: "DEFAULT_PROVIDER", reason: "not an enabled provider" }]);
  }
  const defaultModel = settings.defaultModel ?? defaultProvider.defaultModel;
  if (catalog.find(defaultProvider.id, defaultModel) === undefined) {
    throw new ConfigError([
      { key: "DEFAULT_MODEL", reason: "not in the default provider's catalog" },
    ]);
  }

  const providers = Object.freeze([...enabled.values()]);
  return {
    defaults: Object.freeze({ provider: defaultProvider.id, model: defaultModel }),
    list: () => providers,
    provider: (providerId) => enabled.get(providerId),
    resolve: (requested, base) => {
      const providerId = requested.provider ?? base.provider;
      const provider = enabled.get(providerId);
      if (provider === undefined) {
        return { ok: false, reason: "provider_unavailable" };
      }
      // A provider given alone means its default model, whatever the base model is.
      const model =
        requested.model ?? (requested.provider === undefined ? base.model : provider.defaultModel);
      if (catalog.find(providerId, model) === undefined) {
        return { ok: false, reason: "model_not_supported" };
      }
      return { ok: true, pair: { provider: providerId, model } };
    },
    adapter: (providerId) =>
      enabled.has(providerId) && Object.hasOwn(adapters, providerId)
        ? adapters[providerId]
        : undefined,
  };
}
