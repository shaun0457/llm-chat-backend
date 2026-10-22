import { makeTestApp } from "../test/helpers/app.js";

/**
 * A copy of `value` whose objects list their keys in sorted order at every depth. JavaScript
 * objects always put integer-like keys (HTTP status codes) first, in numeric order; for the
 * three-digit codes of an OpenAPI document that is the same order as sorting them as text.
 */
function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withSortedKeys);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, withSortedKeys(child)]),
    );
  }
  return value;
}

/**
 * The OpenAPI document the API serves at /openapi.json, as the text of docs/openapi.json.
 * Built from the fixed test configuration (TEST_ENV) and a detached database pool, never from
 * process.env or .env, so the output depends only on the code: sorted keys, two-space indent,
 * a final newline.
 */
export async function renderOpenApiDocument(): Promise<string> {
  const app = makeTestApp();
  try {
    await app.ready();
    return `${JSON.stringify(withSortedKeys(app.swagger()), null, 2)}\n`;
  } finally {
    await app.close();
  }
}
