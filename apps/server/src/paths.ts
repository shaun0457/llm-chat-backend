import { fileURLToPath } from "node:url";

// Resolved against this module's URL: src/paths.ts in tests, dist/<entry>.js once bundled. Both
// sit one level below the package root, so this file must stay directly in src/.
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));
export const DEFAULT_MODEL_CATALOG_PATH = fileURLToPath(
  new URL("../config/models.json", import.meta.url),
);
