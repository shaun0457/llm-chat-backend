import { makeTestApp } from "../test/helpers/app.js";

/** A copy of `value` whose objects list their keys in sorted order at every depth. */
function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withSortedKeys);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, withSortedKeys((value as Record<string, unknown>)[key])]),
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
