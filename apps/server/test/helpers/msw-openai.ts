import { HttpResponse, delay, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

/** A host that does not exist: every request to it must be answered by msw. */
export const UPSTREAM_BASE_URL = "https://llm-upstream.test/v1";
const COMPLETIONS_URL = `${UPSTREAM_BASE_URL}/chat/completions`;

export type UpstreamUsage = { prompt_tokens: number; completion_tokens: number };

/** One `chat.completion.chunk`, in the OpenAI wire format. */
export type ChunkSpec = {
  content?: string;
  /** A provider-specific reasoning side field (`reasoning_content`) on the delta. */
  reasoning?: string;
  finishReason?: string;
  usage?: UpstreamUsage;
  /** A usage-only chunk: `choices` is empty. */
  noChoices?: boolean;
};

export function chunk(spec: ChunkSpec): Record<string, unknown> {
  const delta: Record<string, unknown> = {};
  if (spec.content !== undefined) {
    delta.content = spec.content;
  }
  if (spec.reasoning !== undefined) {
    delta.reasoning_content = spec.reasoning;
  }
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices:
      spec.noChoices === true
        ? []
        : [{ index: 0, delta, finish_reason: spec.finishReason ?? null }],
    ...(spec.usage === undefined
      ? {}
      : {
          usage: {
            ...spec.usage,
            total_tokens: spec.usage.prompt_tokens + spec.usage.completion_tokens,
          },
        }),
  };
}

/**
 * A response whose body is a ReadableStream. On purpose (V1): with a string or bytes body, msw
 * never settles the SDK's cancellation of the body (after `[DONE]`, or before a retry), and
 * the call hangs.
 */
function respond(
  text: string,
  init: { status: number; headers: Record<string, string> },
): Response {
  return new HttpResponse(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    init,
  );
}

/** A server-sent event stream of chunks; `done: false` leaves out the closing `[DONE]`. */
export function streamOf(
  chunks: readonly ChunkSpec[],
  options: { done?: boolean } = {},
): Responder {
  const events = chunks.map((spec) => `data: ${JSON.stringify(chunk(spec))}\n\n`);
  if (options.done !== false) {
    events.push("data: [DONE]\n\n");
  }
  return rawStream(events.join(""));
}

/** A server-sent event stream with exactly this text. */
export function rawStream(text: string): Responder {
  return () => respond(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * An upstream error with a JSON body. It carries `retry-after-ms: 0`, so the SDK retries a
 * retryable status at once instead of backing off for seconds.
 */
export function errorOf(status: number, body: unknown): Responder {
  return () =>
    respond(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "retry-after-ms": "0" },
    });
}

/** Never answers within `ms`: for the SDK's request timeout. */
export function slow(ms: number): Responder {
  return async () => {
    await delay(ms);
    return streamOf([{ content: "late", finishReason: "stop" }])();
  };
}

export type Responder = () => Response | Promise<Response>;

export type RecordedRequest = { authorization: string | null; body: Record<string, unknown> };

export type Upstream = {
  /** Every request the upstream received, in order. */
  readonly requests: RecordedRequest[];
  /** Answers the next requests in order; the last responder repeats once the queue runs out. */
  reply(...responders: Responder[]): void;
};

/**
 * An msw-mocked OpenAI-compatible upstream for one test file. Unhandled requests fail the test,
 * so nothing reaches a real network. Responders are reset after each test.
 */
export function useUpstream(): Upstream {
  const requests: RecordedRequest[] = [];
  let queue: Responder[] = [];
  const server = setupServer(
    http.post(COMPLETIONS_URL, async ({ request }) => {
      requests.push({
        authorization: request.headers.get("authorization"),
        body: (await request.json()) as Record<string, unknown>,
      });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next === undefined) {
        return HttpResponse.json({ error: { message: "no responder queued" } }, { status: 418 });
      }
      return next();
    }),
  );

  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => {
    requests.length = 0;
    queue = [];
  });
  afterAll(() => server.close());

  return {
    requests,
    reply(...responders) {
      queue.push(...responders);
    },
  };
}
