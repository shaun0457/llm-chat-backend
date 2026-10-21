import { defineConfig } from "drizzle-kit";

// Only `generate` and `check` are used; they need no database connection.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
