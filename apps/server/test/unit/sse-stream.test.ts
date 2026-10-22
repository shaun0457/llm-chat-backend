import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { type SseStream, openSseStream } from "../../src/http/sse.js";

describe("openSseStream", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("is closed at once when the client left before the stream was opened", async () => {
    let arrived!: () => void;
    const requestArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let opened!: (stream: SseStream) => void;
    const streamOpened = new Promise<SseStream>((resolve) => {
      opened = resolve;
    });
    app = Fastify();
    app.get("/stream", async (_request, reply) => {
      arrived();
      // Like a send whose client disconnects while admission runs.
      await new Promise((resolve) => reply.raw.once("close", resolve));
      opened(openSseStream(reply, { ssePingIntervalMs: 10, sseBufferLimitBytes: 65_536 }));
      return reply;
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;

    const socket = connect(port, "127.0.0.1", () => {
      socket.write("GET /stream HTTP/1.1\r\nHost: test\r\n\r\n");
    });
    socket.on("error", () => {});
    await requestArrived;
    socket.destroy();
    const stream = await streamOpened;
    const closed = await new Promise<boolean>((resolve) => stream.onClose(() => resolve(true)));

    expect(closed).toBe(true);
    expect(stream.closed).toBe(true);
    expect(stream.send("delta", { text: "x" })).toBe(false);
  });

  it("reports an event as not sent once the connection is destroyed, before close is emitted", async () => {
    let opened!: (result: { afterDestroy: boolean; closed: boolean }) => void;
    const result = new Promise<{ afterDestroy: boolean; closed: boolean }>((resolve) => {
      opened = resolve;
    });
    app = Fastify({ logger: false });
    app.get("/stream", async (_request, reply) => {
      const stream = openSseStream(reply, {
        ssePingIntervalMs: 10_000,
        sseBufferLimitBytes: 65_536,
      });
      // The client reset the socket; Node emits 'close' only on a later tick.
      reply.raw.destroy();
      opened({ afterDestroy: stream.send("delta", { text: "x" }), closed: stream.closed });
      return reply;
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;

    // The head was already flushed, so the response may arrive before the reset; either is fine.
    void fetch(`http://127.0.0.1:${port}/stream`)
      .then((response) => response.body?.cancel())
      .catch(() => {});

    expect(await result).toEqual({ afterDestroy: false, closed: true });
  });

  it("closes the connection instead of throwing when the head cannot be written", async () => {
    let opened!: (result: SseStream | Error) => void;
    const streamOpened = new Promise<SseStream | Error>((resolve) => {
      opened = resolve;
    });
    app = Fastify({ logger: false });
    app.get("/stream", async (_request, reply) => {
      // An invalid value set by a hook; Node refuses it only when the head is written.
      void reply.header("x-broken", "line\nbreak");
      try {
        opened(openSseStream(reply, { ssePingIntervalMs: 10, sseBufferLimitBytes: 65_536 }));
      } catch (error) {
        opened(error as Error);
      }
      return reply;
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;

    await expect(fetch(`http://127.0.0.1:${port}/stream`)).rejects.toThrow();
    const stream = await streamOpened;

    expect(stream).not.toBeInstanceOf(Error);
    await new Promise<void>((resolve) => (stream as SseStream).onClose(resolve));
    expect((stream as SseStream).closed).toBe(true);
  });
});
