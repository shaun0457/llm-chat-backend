import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { renderOpenApiDocument } from "./openapi-document.js";

/**
 * `pnpm docs:openapi`: writes the OpenAPI document to the path given as the only argument
 * (docs/openapi.json from the package script). CI regenerates it and fails on any difference.
 */
async function main(): Promise<void> {
  const target = process.argv[2];
  if (target === undefined || process.argv.length !== 3) {
    throw new Error("usage: write-openapi <output file>");
  }
  const path = resolve(target);
  await writeFile(path, await renderOpenApiDocument(), "utf8");
  process.stdout.write(`wrote ${path}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `OpenAPI generation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exit(1);
});
