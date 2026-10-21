import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = fileURLToPath(new URL("../..", import.meta.url));
// Nothing listens there: the server starts without connecting, and /health needs no database.
const UNUSED_DATABASE_URL = "postgres://app:pw@127.0.0.1:9/app";
const LISTENING = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/;

type Exit = { code: number | null; signal: NodeJS.Signals | null };

function startServer(env: Record<string, string>): {
  child: ChildProcessWithoutNullStreams;
  output: () => { stdout: string; stderr: string };
  exited: Promise<Exit>;
} {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: SERVER_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      HOST: "127.0.0.1",
      PORT: "0",
      DATABASE_URL: UNUSED_DATABASE_URL,
      ...env,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<Exit>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return { child, output: () => ({ stdout, stderr }), exited };
}

async function waitForUrl(
  server: { output: () => { stdout: string; stderr: string }; exited: Promise<Exit> },
  timeoutMs = 10_000,
): Promise<string> {
  let exit: Exit | undefined;
  void server.exited.then((value) => (exit = value));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && exit === undefined) {
    const match = LISTENING.exec(server.output().stdout);
    if (match?.[1] !== undefined) {
      return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const { stdout, stderr } = server.output();
  throw new Error(`server did not start (exit: ${JSON.stringify(exit)}): ${stdout}${stderr}`);
}

describe("server entry (built dist/index.js)", () => {
  let running: ChildProcessWithoutNullStreams | undefined;

  afterEach(() => {
    if (running !== undefined && running.exitCode === null) {
      running.kill("SIGKILL");
    }
    running = undefined;
  });

  // Windows has no catchable SIGTERM (kill() terminates the process); CI runs this on Linux.
  it.skipIf(process.platform === "win32")(
    "serves /health and exits 0 within 10 s after SIGTERM",
    async () => {
      const server = startServer({ NODE_ENV: "production" });
      running = server.child;
      const url = await waitForUrl(server);

      const response = await fetch(`${url}/health`);
      expect(response.status).toBe(200);

      const started = Date.now();
      server.child.kill("SIGTERM");
      const exit = await server.exited;

      expect(exit).toEqual({ code: 0, signal: null });
      expect(Date.now() - started).toBeLessThan(10_000);
    },
    20_000,
  );

  it("exits non-zero naming the invalid key, never its value", async () => {
    const server = startServer({ PORT: "abc" });
    running = server.child;

    const exit = await server.exited;

    expect(exit.code).not.toBe(0);
    expect(exit.code).not.toBeNull();
    const { stdout, stderr } = server.output();
    expect(stderr).toContain("PORT");
    expect(stdout + stderr).not.toContain("abc");
  });

  describe("with a bad model catalog", () => {
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "catalog-"));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("exits non-zero naming the catalog file and the invalid entry", async () => {
      const path = join(dir, "models.json");
      await writeFile(
        path,
        JSON.stringify({
          providers: {
            demo: { defaultModel: "demo", requiresKey: false, models: [{ id: "demo" }] },
          },
        }),
      );
      const server = startServer({ MODEL_CATALOG_PATH: path });
      running = server.child;

      const exit = await server.exited;

      expect(exit.code).toBe(1);
      const { stderr } = server.output();
      expect(stderr).toContain(path);
      expect(stderr).toContain("providers.demo.models.0.contextWindow");
    });

    it("exits non-zero naming an enabled provider missing from the catalog", async () => {
      const server = startServer({ PROVIDERS_ENABLED: "demo,ghost" });
      running = server.child;

      const exit = await server.exited;

      expect(exit.code).toBe(1);
      expect(server.output().stderr).toMatch(/PROVIDERS_ENABLED.*ghost/);
    });
  });
});
