import { type Server, createServer } from "node:http";
import { type AddressInfo, type Socket, connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { TEST_ENV, makeTestApp } from "../helpers/app.js";
import { closeListeningApp, listen } from "../helpers/sse-client.js";

/** Everything the server writes until it closes the connection. */
function readUntilClose(socket: Socket): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString();
    });
    socket.on("close", () => resolve(text));
  });
}

/**
 * V3: a JSON-mode reply may take up to 195 s. These tests show, with timeouts scaled down,
 * which Node 22 server timeouts can end a response that is still being produced.
 */
describe("server timeouts versus slow responses", () => {
  const RESPONSE_DELAY_MS = 1_500;
  let server: Server | undefined;

  afterEach(async () => {
    const current = server;
    server = undefined;
    if (current !== undefined) {
      current.closeAllConnections();
      await new Promise((resolve) => current.close(resolve));
    }
  });

  async function slowServer(options: Parameters<typeof createServer>[0], socketTimeoutMs: number) {
    server = createServer(options, (_request, response) => {
      setTimeout(() => response.end("late"), RESPONSE_DELAY_MS);
    });
    server.setTimeout(socketTimeoutMs);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/`;
  }

  it("request, headers and keep-alive timeouts do not end a response once the request arrived", async () => {
    const url = await slowServer(
      {
        requestTimeout: 300,
        headersTimeout: 200,
        keepAliveTimeout: 100,
        connectionsCheckingInterval: 50,
      },
      0,
    );

    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("late");
  });

  it("control: a socket inactivity timeout shorter than the response does end it", async () => {
    const url = await slowServer({}, 300);

    await expect(fetch(url)).rejects.toThrow();
  });

  it("a request timeout ends a request whose body arrives too slowly", async () => {
    server = createServer(
      { requestTimeout: 300, connectionsCheckingInterval: 50 },
      (request, response) => {
        request.resume();
        request.on("end", () => response.end("done"));
      },
    );
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const socket = connect(port, "127.0.0.1");
    // The headers promise 100 bytes of body; only 4 ever arrive.
    socket.write(["POST / HTTP/1.1", "Host: x", "Content-Length: 100", "", "slow"].join("\r\n"));
    const answer = await new Promise<string>((resolve) => {
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk.toString();
      });
      socket.on("close", () => resolve(text));
    });

    expect(answer).toMatch(/^HTTP\/1\.1 408/);
  });

  it("the app bounds receiving a request (REQUEST_TIMEOUT_MS) but never a response: no socket inactivity timeout", async () => {
    const app = makeTestApp({ config: loadConfig({ ...TEST_ENV, REQUEST_TIMEOUT_MS: "12000" }) });
    await app.ready();

    expect(app.server.timeout).toBe(0);
    expect(app.server.requestTimeout).toBe(12_000);
    expect(app.server.headersTimeout).toBe(12_000);
    await app.close();
  });
});

describe("REQUEST_TIMEOUT_MS on the listening app", () => {
  it.each([
    ["a stalled body", ["Content-Type: application/json", "Content-Length: 100", "", '{"a"']],
    ["stalled headers", ["Content-Type: application/json"]],
  ])(
    "answers %s with 408 within the timeout plus one connection check",
    async (_name, rest) => {
      const app = makeTestApp({
        config: loadConfig({ ...TEST_ENV, REQUEST_TIMEOUT_MS: "1000" }),
      });
      try {
        const { hostname, port } = new URL(await listen(app));
        const socket = connect(Number(port), hostname);
        const started = performance.now();
        socket.write(["POST /sessions HTTP/1.1", "Host: x", ...rest].join("\r\n"));
        const answer = await readUntilClose(socket);
        const elapsedMs = performance.now() - started;

        expect(answer).toMatch(/^HTTP\/1\.1 408/);
        expect(elapsedMs).toBeGreaterThanOrEqual(950);
        // 1 s, plus one check interval (100 ms at this timeout), plus scheduling margin.
        expect(elapsedMs).toBeLessThan(2_100);
      } finally {
        await closeListeningApp(app);
      }
    },
    90_000,
  );
});
