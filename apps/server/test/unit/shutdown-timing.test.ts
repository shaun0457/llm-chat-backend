import { describe, expect, it } from "vitest";

import { jobShutdownWaitMs } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { shutdownTimeoutMs } from "../../src/server.js";

const config = loadConfig({
  DATABASE_URL: "postgres://x@db/x",
  TERMINAL_STATEMENT_TIMEOUT_MS: "3000",
  TERMINAL_WRITE_BUDGET_MS: "10000",
});

describe("shutdown timing", () => {
  it("gives an aborted job time to stop, wait out a stalled flush, and use its whole terminal budget", () => {
    // Stop grace (1 s) + one statement timeout for the last flush + the terminal-write budget.
    expect(jobShutdownWaitMs(config)).toBe(14_000);
  });

  it("forces the exit only after the jobs' wait, with time left to close the server", () => {
    expect(shutdownTimeoutMs(config)).toBe(18_000);
  });
});
