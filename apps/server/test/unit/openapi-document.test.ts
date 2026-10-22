import { describe, expect, it } from "vitest";

import { renderOpenApiDocument } from "../../scripts/openapi-document.js";

/** Every object's own keys, at every depth, as [path, keys] pairs. */
function objectKeys(value: unknown, path = "$"): Array<[string, string[]]> {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => objectKeys(item, `${path}[${index}]`));
  }
  if (typeof value === "object" && value !== null) {
    return [
      [path, Object.keys(value)],
      ...Object.entries(value).flatMap(([key, child]) => objectKeys(child, `${path}.${key}`)),
    ];
  }
  return [];
}

describe("docs/openapi.json generation", () => {
  it("renders identical bytes on every run", async () => {
    const first = await renderOpenApiDocument();
    const second = await renderOpenApiDocument();

    expect(second).toBe(first);
  });

  it("renders the app's OpenAPI 3.1 document as indented JSON with sorted keys", async () => {
    const text = await renderOpenApiDocument();

    expect(text.endsWith("}\n")).toBe(true);
    expect(text.split("\n")[1]).toMatch(/^ {2}"/);
    const document = JSON.parse(text);
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        "/health",
        "/health/ready",
        "/providers",
        "/sessions",
        "/sessions/{id}",
        "/sessions/{id}/messages",
        "/sessions/{id}/messages/{mid}",
      ]),
    );
    const unsorted = objectKeys(document).filter(
      ([, keys]) => keys.join("\n") !== [...keys].sort().join("\n"),
    );
    expect(unsorted).toEqual([]);
  });
});
