import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Process tests run the built server, so build once per test run (no manual build needed). */
export default function setup(): void {
  execFileSync("pnpm", ["run", "build"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}
