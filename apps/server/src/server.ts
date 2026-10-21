import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";
import { type AppConfig, ConfigError, loadConfig } from "./config.js";

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
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const app = buildApp({ config });
  handleShutdownSignals(app);
  await app.listen({ port: config.port, host: config.host });
}
