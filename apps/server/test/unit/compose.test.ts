import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { POSTGRES_IMAGE } from "../postgres-image.js";

const compose = readFileSync(new URL("../../../../docker-compose.yml", import.meta.url), "utf8");

describe("docker-compose.yml", () => {
  it("runs the PostgreSQL image the tests run against", () => {
    expect(compose).toContain(`image: ${POSTGRES_IMAGE}\n`);
  });
});
