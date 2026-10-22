import type { FastifyReply } from "fastify";
import type { OutgoingHttpHeaders } from "node:http";

/** A comment frame: keeps proxies from closing a stream that is quiet for a while. */
export const PING_FRAME = ": ping\n\n";

/**
 * One server-sent event: `event: <name>`, one `data:` line, a blank line. JSON.stringify escapes
 * CR and LF inside strings, so the payload never spans lines. No `id:` lines: streams are not
 * resumed with Last-Event-ID (a re-attach starts from a snapshot instead).
 */
export function encodeEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** What an event stream needs to know; an AppConfig has them all. */
export type SseOptions = Readonly<{ ssePingIntervalMs: number; sseBufferLimitBytes: number }>;

/** One open event stream to one client. */
export interface SseStream {
  /**
   * Writes one event. False when nothing was written: the stream is closed or ending, or this
   * frame would have exceeded the connection's buffer limit, which closes the connection.
   */
  send(event: string, data: unknown): boolean;
  /** Ends the response after everything written so far. Idempotent. */
  end(): void;
  /**
   * Runs `listener` once the connection is closed for any reason: ended, client gone, closed
   * as a slow consumer, or failed. At once if it already is.
   */
  onClose(listener: () => void): void;
  /** True once the stream accepts no more events (ending or closed). */
  readonly closed: boolean;
}

const SSE_HEADERS: OutgoingHttpHeaders = {
  "content-type": "text/event-stream; charset=utf-8",
  // no-transform: proxies must not compress or rewrite the stream.
  "cache-control": "no-cache, no-transform",
  // nginx and compatible proxies: do not buffer this response.
  "x-accel-buffering": "no",
  "connection": "keep-alive",
};

/**
 * Takes over the reply and opens an event stream on it: the headers already set on the reply
 * (by hooks: the request id, later CORS and security headers) plus the SSE headers, written at
 * once. Fastify sends nothing more for a hijacked reply; its response logging still runs when
 * the stream ends. Call only after every check that can answer with problem details.
 *
 * Pending bytes are the response's `writableLength`: what Node holds for this connection and
 * has not yet handed to the operating system (V3 in ADR 0006). A frame that would take them
 * past `sseBufferLimitBytes` is not written; the connection is destroyed instead.
 */
export function openSseStream(reply: FastifyReply, options: SseOptions): SseStream {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) {
      headers[name] = value;
    }
  }
  Object.assign(headers, SSE_HEADERS);
  void reply.hijack();
  const response = reply.raw;
  response.writeHead(200, headers);
  response.flushHeaders();

  let ending = false;
  let closed = false;
  const listeners: Array<() => void> = [];

  const write = (frame: string): boolean => {
    if (ending) {
      return false;
    }
    const pendingBytes = response.writableLength;
    if (pendingBytes + Buffer.byteLength(frame, "utf8") > options.sseBufferLimitBytes) {
      reply.log.warn(
        { pendingBytes, limitBytes: options.sseBufferLimitBytes },
        "closing an event stream whose client does not keep up",
      );
      ending = true;
      response.destroy();
      return false;
    }
    response.write(frame);
    return true;
  };

  const ping = setInterval(() => write(PING_FRAME), options.ssePingIntervalMs);

  const onClosed = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    ending = true;
    clearInterval(ping);
    for (const listener of listeners.splice(0)) {
      try {
        listener();
      } catch (error) {
        reply.log.warn({ err: error }, "an event stream close listener threw");
      }
    }
  };
  response.on("close", onClosed);
  // A write error is followed by close; it must not become an unhandled error event.
  response.on("error", () => response.destroy());

  return {
    send: (event, data) => write(encodeEvent(event, data)),
    end() {
      if (ending) {
        return;
      }
      ending = true;
      clearInterval(ping);
      response.end();
    },
    onClose(listener) {
      if (closed) {
        listener();
      } else {
        listeners.push(listener);
      }
    },
    get closed() {
      return ending;
    },
  };
}
