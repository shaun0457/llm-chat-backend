import { ConfigError, loadConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { MIGRATIONS_FOLDER } from "./paths.js";

/**
 * One-shot migration step (the compose `migrate` service, a platform's pre-deploy command).
 * The API process never migrates. Exit code 0 on success, 1 on any failure.
 */
async function main(): Promise<void> {
  let databaseUrl: string;
  try {
    databaseUrl = loadConfig(process.env).databaseUrl;
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  try {
    await runMigrations(databaseUrl, MIGRATIONS_FOLDER);
    process.stdout.write("Migrations applied\n");
  } catch (error) {
    // pg error messages name hosts and users, never the password from the URL.
    const reason = error instanceof Error ? error.message : "unknown error";
    process.stderr.write(`Migration failed: ${reason}\n`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Migration failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exit(1);
});
