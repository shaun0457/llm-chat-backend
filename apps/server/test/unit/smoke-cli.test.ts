import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** Runs the smoke script the way CI does: plain Node, which strips the types. */
function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/smoke-local-llm.ts", ...args], {
      cwd: SERVER_DIR,
      env: { PATH: process.env.PATH ?? "" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("smoke-local-llm command line", () => {
  it("exits 1 with a clear message when nothing answers at the base URL", async () => {
    // Nothing listens on port 9 (discard) of the loopback address.
    const { code, stderr } = await runCli(["--base-url", "http://127.0.0.1:9"]);

    expect(code).toBe(1);
    expect(stderr).toContain("SMOKE FAILED");
    expect(stderr).toContain("cannot reach http://127.0.0.1:9");
  });

  it("exits 2 on an unknown option", async () => {
    const { code, stderr } = await runCli(["--nope"]);

    expect(code).toBe(2);
    expect(stderr).toContain("Usage:");
  });
});
