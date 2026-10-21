import { defineConfig } from "vitest/config";

// "unit" needs neither a build nor Docker. "integration" builds dist once (process tests run
// the built entries) and starts one PostgreSQL container for the whole run.
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts", "test/lint/**/*.test.ts"],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts", "test/process/**/*.test.ts"],
          globalSetup: ["test/global-setup.ts", "test/postgres-setup.ts"],
          hookTimeout: 60_000,
          // Two files at a time keeps peak memory low enough for a laptop running Docker.
          // A different worker limit requires its own group; unit tests run first.
          maxWorkers: 2,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
