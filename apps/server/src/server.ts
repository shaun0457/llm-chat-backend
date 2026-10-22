import type { FastifyInstance } from "fastify";

import { buildApp, jobShutdownWaitMs } from "./app.js";
import { type AppConfig, ConfigError, loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { CatalogError, type ModelCatalog, loadCatalog } from "./llm/catalog.js";
import { createAdapters } from "./llm/providers.js";
import { type ProviderRegistry, createRegistry } from "./llm/registry.js";

/** Time to close the server and the pool after the jobs' wait. */
const CLOSE_MARGIN_MS = 4_000;

/**
 * The forced-exit timeout: the jobs' wait (stop grace + one statement timeout + terminal-write
 * budget) plus a margin, so that aborted generations can store their final state first (18 s
 * by default). A
 * platform's stop grace period must be longer, or it kills the process first.
 */
export function shutdownTimeoutMs(config: AppConfig): number {
  return jobShutdownWaitMs(config) + CLOSE_MARGIN_MS;
}

/** SIGTERM/SIGINT → app.close() → exit 0; a second signal or the timeout forces exit 1. */
function handleShutdownSignals(app: FastifyInstance, timeoutMs: number): void {
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
    }, timeoutMs).unref();

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
    registry = createRegistry(catalog, config, createAdapters(config));
  } catch (error) {
    if (error instanceof ConfigError || error instanceof CatalogError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  // Declared before the pool, so its error handler never meets an uninitialised binding.
  let app: FastifyInstance | undefined;
  // The pool connects lazily: the API starts even while the database is down (not ready).
  const db = createDb({
    connectionString: config.databaseUrl,
    statementTimeoutMs: config.dbStatementTimeoutMs,
    onPoolError: (error) => {
      if (app === undefined) {
        process.stderr.write(`idle database connection failed: ${error.message}\n`);
      } else {
        app.log.error({ err: error }, "idle database connection failed");
      }
    },
  });
  try {
    app = buildApp({ config, db, catalog, registry });
  } catch (error) {
    // e.g. the bundled migrations folder is missing from the build.
    await db.close();
    throw error;
  }
  app.addHook("onClose", () => db.close());
  handleShutdownSignals(app, shutdownTimeoutMs(config));
  await app.listen({ port: config.port, host: config.host });
}
