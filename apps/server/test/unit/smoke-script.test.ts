import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { runSmoke } from "../../scripts/smoke-local-llm.js";

/**
 * A scripted stand-in for the API, so that the order of events the smoke script sees is fixed:
 * here the failed long answer's slot is free (the extra send is admitted, 202) before its
 * stream's error event arrives, the ordering a real server can produce.
 */
function fakeApi(): {
  start: () => Promise<string>;
  stop: () => Promise<void>;
  deleted: string[];
  extraSession: () => string | undefined;
} {
  const deleted: string[] = [];
  let extraSession: string | undefined;
  let sessions = 0;
  let longStreams = 0;
  let failLong: (() => void) | undefined;
  const message = (status: string, extra: Record<string, unknown> = {}) => ({
    status,
    content: status === "generating" ? "" : "4",
    finishReason: status === "completed" ? "stop" : null,
    usage: null,
    errorCode: null,
    errorDetail: null,
    ...extra,
  });
  const json = (res: ServerResponse, status: number, body: unknown, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const event = (res: ServerResponse, name: string, data: unknown) =>
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

  const handle = (req: IncomingMessage, res: ServerResponse, body: string): void => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/providers") {
      json(res, 200, {
        providers: [
          {
            id: "ollama",
            defaultModel: "m",
            models: [{ id: "m", contextWindow: 4096, maxOutputTokens: 512 }],
          },
        ],
      });
    } else if (req.method === "POST" && url === "/sessions") {
      sessions += 1;
      json(res, 201, { id: `s${sessions}` });
    } else if (req.method === "DELETE" && url.startsWith("/sessions/")) {
      deleted.push(url.slice("/sessions/".length));
      res.writeHead(204).end();
    } else if (req.method === "POST" && url.endsWith("/messages")) {
      const long = (JSON.parse(body) as { content: string }).content.startsWith("Write every");
      if (req.headers.accept === "text/event-stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        event(res, "message.created", { userMessage: {}, assistantMessage: message("generating") });
        event(res, "delta", { id: "a", attempt: 1, text: "4" });
        if (!long) {
          event(res, "done", { assistantMessage: message("completed") });
          res.end();
          return;
        }
        longStreams += 1;
        if (longStreams === 2) {
          // Fails only once the extra send was admitted in its place.
          failLong = () => {
            event(res, "error", {
              code: "llm_upstream_error",
              detail: "boom",
              assistantMessage: message("failed", {
                errorCode: "llm_upstream_error",
                errorDetail: "boom",
              }),
            });
            res.end();
          };
        }
        return; // the first long answer never ends on its own
      }
      if (req.headers.prefer === "respond-async") {
        extraSession = url.split("/")[2];
        json(
          res,
          202,
          { userMessage: {}, assistantMessage: message("generating") },
          { "location": `${url}/x`, "retry-after": "2" },
        );
        res.once("finish", () => failLong?.());
        return;
      }
      json(res, 200, { userMessage: {}, assistantMessage: message("completed") });
    } else {
      json(res, 404, { code: "not_found" });
    }
  };

  let server: Server | undefined;
  return {
    deleted,
    extraSession: () => extraSession,
    start: async () => {
      server = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk.toString()));
        req.on("end", () => handle(req, res, body));
      });
      await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    stop: async () => {
      server?.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    },
  };
}

describe("smoke-local-llm limit check, in a fixed order of events", () => {
  const api = fakeApi();

  afterEach(async () => {
    await api.stop();
  });

  it("reports the failed long answer, not the admitted extra send, and deletes the extra session", async () => {
    const baseUrl = await api.start();

    await expect(
      runSmoke({ baseUrl, provider: "ollama", limitCheck: true, log: () => {} }),
    ).rejects.toThrow(/long answer \d failed: llm_upstream_error: boom/);
    // The admitted extra send's generation is not left running.
    expect(api.extraSession()).toBeDefined();
    expect(api.deleted).toEqual([api.extraSession()]);
  });
});
