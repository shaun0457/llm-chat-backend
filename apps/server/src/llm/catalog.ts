import { readFileSync } from "node:fs";
import { z } from "zod";

const modelSchema = z.strictObject({
  id: z.string().min(1),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
});

const providerSchema = z
  .strictObject({
    defaultModel: z.string().min(1),
    requiresKey: z.boolean(),
    maxConcurrency: z.number().int().positive().optional(),
    models: z.array(modelSchema).min(1),
  })
  .superRefine((provider, ctx) => {
    const seen = new Set<string>();
    provider.models.forEach((model, index) => {
      if (seen.has(model.id)) {
        ctx.addIssue({ code: "custom", path: ["models", index, "id"], message: "duplicate" });
      }
      seen.add(model.id);
      if (model.maxOutputTokens >= model.contextWindow) {
        ctx.addIssue({
          code: "custom",
          path: ["models", index, "maxOutputTokens"],
          message: "must be below contextWindow",
        });
      }
    });
    if (!seen.has(provider.defaultModel)) {
      ctx.addIssue({ code: "custom", path: ["defaultModel"], message: "not in models" });
    }
  });

// Base URLs are deliberately absent: they are server configuration, never catalog data.
const catalogSchema = z.strictObject({
  providers: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), providerSchema),
});

export type ModelEntry = Readonly<z.infer<typeof modelSchema>>;
export type ProviderEntry = Readonly<{
  defaultModel: string;
  requiresKey: boolean;
  maxConcurrency?: number;
  models: readonly ModelEntry[];
}>;

export interface ModelCatalog {
  provider(id: string): ProviderEntry | undefined;
  find(provider: string, model: string): ModelEntry | undefined;
}

/** Names the catalog file and the offending JSON paths. */
export class CatalogError extends Error {
  constructor(source: string, reason: string) {
    super(`Invalid model catalog ${source}: ${reason}`);
    this.name = "CatalogError";
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export function parseCatalog(input: unknown, source: string): ModelCatalog {
  const result = catalogSchema.safeParse(input);
  if (!result.success) {
    const reasons = result.error.issues.map((issue) => {
      const at = issue.path.length === 0 ? "(root)" : issue.path.join(".");
      return `${at} (${issue.code === "custom" ? issue.message : issue.code})`;
    });
    throw new CatalogError(source, reasons.join(", "));
  }

  const providers = new Map(Object.entries(deepFreeze(result.data).providers));
  return {
    provider: (id) => providers.get(id),
    find: (provider, model) => providers.get(provider)?.models.find((entry) => entry.id === model),
  };
}

export function loadCatalog(path: string): ModelCatalog {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
    throw new CatalogError(path, `cannot read the file (${code})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CatalogError(path, "not valid JSON");
  }
  return parseCatalog(json, path);
}
