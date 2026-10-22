import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";

/** One frame of a server-sent event stream: an event with its JSON data, or a comment. */
export type SseFrame =
  | { kind: "event"; event: string; data: unknown; raw: string }
  | { kind: "comment"; text: string; raw: string };

export type SseEvent = Extract<SseFrame, { kind: "event" }>;

function parseFrame(raw: string): SseFrame {
  const lines = raw.split("\n");
  if (lines.every((line) => line.startsWith(":"))) {
    return { kind: "comment", text: lines.map((line) => line.slice(1).trim()).join("\n"), raw };
  }
  let event = "message";
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event: ")) {
      event = line.slice("event: ".length);
    } else if (line.startsWith("data: ")) {
      data.push(line.slice("data: ".length));
    } else {
      throw new Error(`unexpected SSE line: ${JSON.stringify(line)}`);
    }
  }
  if (data.length !== 1) {
    throw new Error(`expected exactly one data line, got ${data.length}: ${JSON.stringify(raw)}`);
  }
  return { kind: "event", event, data: JSON.parse(data[0] ?? ""), raw };
}

/** Every frame of a complete stream body, e.g. one returned by inject(). */
export function parseSse(body: string): SseFrame[] {
  const frames = body.split("\n\n");
  if (frames.at(-1) !== "") {
    throw new Error(`the stream does not end with a complete frame: ${JSON.stringify(body)}`);
  }
  return frames.slice(0, -1).map(parseFrame);
}

export const eventsOf = (frames: readonly SseFrame[]): SseEvent[] =>
  frames.filter((frame): frame is SseEvent => frame.kind === "event");

/** Starts listening on a free local port and returns the base URL. */
export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

export type SseConnection = {
  readonly status: number;
  readonly headers: Headers;
  /** The next frame; undefined once the stream has ended. Rejects if the connection broke. */
  next(): Promise<SseFrame | undefined>;
  /** The next event, skipping comments; undefined once the stream has ended. */
  nextEvent(): Promise<SseEvent | undefined>;
  /** Every remaining frame until the stream ends, and the error if it did not end cleanly. */
  drain(): Promise<{ frames: SseFrame[]; error: unknown }>;
  /** Closes the connection from the client's side. */
  close(): void;
};

/**
 * Opens a request over a real socket and reads its body as server-sent events, one frame at
 * a time. Nothing is read until the test asks for a frame, so a test can stop reading (a slow
 * consumer) simply by not calling next().
 */
export async function openSse(url: string, init: RequestInit = {}): Promise<SseConnection> {
  const controller = new AbortController();
  const response = await fetch(url, { ...init, signal: controller.signal });
  if (response.body === null) {
    throw new Error("the response has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;

  const next = async (): Promise<SseFrame | undefined> => {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end !== -1) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        return parseFrame(raw);
      }
      if (ended) {
        if (buffer.length > 0) {
          throw new Error(`the stream ended inside a frame: ${JSON.stringify(buffer)}`);
        }
        return undefined;
      }
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        buffer += decoder.decode();
      } else {
        buffer += decoder.decode(value, { stream: true });
      }
    }
  };

  const nextEvent = async (): Promise<SseEvent | undefined> => {
    for (;;) {
      const frame = await next();
      if (frame === undefined || frame.kind === "event") {
        return frame;
      }
    }
  };

  return {
    status: response.status,
    headers: response.headers,
    next,
    nextEvent,
    async drain() {
      const frames: SseFrame[] = [];
      try {
        for (;;) {
          const frame = await next();
          if (frame === undefined) {
            return { frames, error: undefined };
          }
          frames.push(frame);
        }
      } catch (error) {
        return { frames, error };
      }
    },
    close: () => controller.abort(),
  };
}
