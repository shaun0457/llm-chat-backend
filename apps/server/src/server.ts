import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";
import { type AppConfig, ConfigError, loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { CatalogError, type ModelCatalog, loadCatalog } from "./llm/catalog.js";
import { type ProviderRegistry, createRegistry } from "./llm/registry.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

/** SIGTERM/SIGINT → app.close() → exit 0; a second signal or the timeout forces exit 1. */
function handleShutdownSignals(app: FastifyInstance): void {
  let closing = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) {
      app.log.warn({ signal }, "second signal, forcing exit");
      process.exit(1);
    }
    closing = true;
    app.log.info({ signal }, "shutting down");

    setTimeout(() => {
      app.log.error("graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, "error during shutdown");
        process.exit(1);
      },
    );
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  let config: AppConfig;
  let catalog: ModelCatalog;
  let registry: ProviderRegistry;
  try {
    config = loadConfig(env);
    catalog = loadCatalog(config.modelCatalogPath);
    registry = createRegistry(catalog, config);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof CatalogError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  // The pool connects lazily: the API starts even while the database is down (not ready).
  const db = createDb({
    connectionString: config.databaseUrl,
    onPoolError: (error) => app.log.error({ err: error }, "idle database connection failed"),
  });
  let app: FastifyInstance;
  try {
    app = buildApp({ config, db, catalog, registry });
  } catch (error) {
    // e.g. the bundled migrations folder is missing from the build.
    await db.close();
    throw error;
  }
  app.addHook("onClose", () => db.close());
  handleShutdownSignals(app);
  await app.listen({ port: config.port, host: config.host });
}
