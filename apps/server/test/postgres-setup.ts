import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import type { TestProject } from "vitest/node";

import { runMigrations } from "../src/db/migrate.js";
import { MIGRATIONS_FOLDER } from "../src/paths.js";
import { POSTGRES_IMAGE } from "./postgres-image.js";

const TEMPLATE_DATABASE = "app_template";

declare module "vitest" {
  export interface ProvidedContext {
    postgres: { adminUrl: string; templateDatabase: string };
  }
}

/**
 * One PostgreSQL container per test run. A template database is migrated once; each test file
 * clones it (see helpers/db.ts). Durability is off: the data is thrown away anyway.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withCommand(["postgres", "-c", "fsync=off", "-c", "synchronous_commit=off"])
    .start();
  const adminUrl = container.getConnectionUri();

  try {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${TEMPLATE_DATABASE}`);
    } finally {
      await admin.end();
    }
    const templateUrl = new URL(adminUrl);
    templateUrl.pathname = `/${TEMPLATE_DATABASE}`;
    await runMigrations(templateUrl.toString(), MIGRATIONS_FOLDER);
  } catch (error) {
    await container.stop();
    throw error;
  }

  project.provide("postgres", { adminUrl, templateDatabase: TEMPLATE_DATABASE });
  return async () => {
    await container.stop();
  };
}
