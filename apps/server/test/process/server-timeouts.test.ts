import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { makeTestApp } from "../helpers/app.js";

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

  it("the app keeps Fastify's defaults: no socket inactivity timeout, no request timeout", async () => {
    const app = makeTestApp();
    await app.ready();

    expect(app.server.timeout).toBe(0);
    expect(app.server.requestTimeout).toBe(0);
    await app.close();
  });
});
