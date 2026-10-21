import { main } from "./server.js";

main().catch((error: unknown) => {
  process.stderr.write(`Server failed to start: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exit(1);
});
