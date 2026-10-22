/**
 * Smoke test of one provider through a running API: one question as an event stream and one as
 * JSON, each must end in a completed, non-empty answer without inlined reasoning. With
 * `--limit-check` it also proves the provider's concurrency limit and output cap: `concurrency`
 * long answers at once, one more send that must get 503 provider_busy, and every long answer
 * must stop at the catalog's maxOutputTokens (finish reason `length`).
 *
 * CI's local-llm job runs it against the compose stack with Ollama; it works against any base
 * URL. Plain Node runs it (type stripping), so it imports nothing but Node built-ins.
 *
 *   node scripts/smoke-local-llm.ts --base-url http://127.0.0.1:3000 --provider ollama
 *
 * Exit codes: 0 passed (last line `SMOKE_RESULT {json}`), 1 failed (`SMOKE FAILED: why` on
 * stderr), 2 bad command line.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const QUESTION = "What is 2+2? Answer with one number.";
/** Far longer than any catalogued output limit, so an answer can only stop at the cap. */
export const LONG_QUESTION = "Count from 1 to 1000, separated by spaces. Do not skip any number.";

const REASONING_MARKERS = /<\/?(think|thinking|reasoning)>/i;
const POLL_INTERVAL_MS = 2_000;

type Usage = { promptTokens: number; completionTokens: number } | null;

type AssistantMessage = {
  id: string;
  status: "generating" | "completed" | "failed";
  content: string;
  finishReason: string | null;
  usage: Usage;
  errorCode: string | null;
  errorDetail: string | null;
};

type ProviderInfo = {
  id: string;
  defaultModel: string;
  models: Array<{ id: string; contextWindow: number; maxOutputTokens: number }>;
};

export type SmokeOptions = {
  baseUrl: string;
  /** Default "ollama". */
  provider?: string;
  /** `Prefer: wait=N` of the JSON send. Default 180. */
  jsonWaitSeconds?: number;
  /** How long a 202 is polled, and how long a stream may take. Default 240. */
  answerTimeoutSeconds?: number;
  limitCheck?: boolean;
  /** The provider's limit, for the limit check. Default 2. */
  concurrency?: number;
  /** Progress lines. Default: stdout. */
  log?: (line: string) => void;
};

export type AnswerReport = {
  status: string;
  finishReason: string | null;
  usage: Usage;
  /** The answer, cut to 200 characters. */
  content: string;
};

export type SmokeResult = {
  provider: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  sse: AnswerReport & { deltas: number; firstDeltaMs: number | null; totalMs: number };
  json: AnswerReport & { httpStatus: number; polls: number; totalMs: number };
  limit?: {
    concurrency: number;
    rejected: { httpStatus: number; code: string | null; retryAfter: string | null };
    answers: Array<AnswerReport & { firstDeltaMs: number | null; totalMs: number }>;
    /** Every answer had started before any had ended: the provider served them in parallel. */
    overlapped: boolean;
  };
};

/** A failed check; the message says what was expected and what came back. */
export class SmokeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeError";
  }
}

type Context = { baseUrl: string; answerTimeoutMs: number; log: (line: string) => void };

async function call(
  ctx: Context,
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? 30_000;
  try {
    return await fetch(`${ctx.baseUrl}${path}`, {
      method,
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new SmokeError(`${method} ${path}: no answer within ${timeoutMs / 1000} s`);
    }
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new SmokeError(`cannot reach ${ctx.baseUrl} (${method} ${path}): ${reason}`);
  }
}

async function bodyOf(response: Response, what: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new SmokeError(
      `${what}: HTTP ${response.status} without a JSON body: ${text.slice(0, 200)}`,
    );
  }
}

function problem(status: number, body: Record<string, unknown>, what: string): SmokeError {
  return new SmokeError(
    `${what}: HTTP ${status} ${String(body.code ?? "")}: ${String(body.detail ?? "")}`.trim(),
  );
}

async function createSession(ctx: Context, provider: string): Promise<string> {
  const response = await call(ctx, "POST", "/sessions", { body: { provider } });
  const body = await bodyOf(response, "POST /sessions");
  if (response.status !== 201 || typeof body.id !== "string") {
    throw problem(response.status, body, "POST /sessions");
  }
  return body.id;
}

function report(message: AssistantMessage): AnswerReport {
  return {
    status: message.status,
    finishReason: message.finishReason,
    usage: message.usage,
    content: message.content.slice(0, 200),
  };
}

/** A completed, non-empty answer with no reasoning in its text, or a SmokeError. */
function checkAnswer(what: string, message: AssistantMessage): void {
  if (message.status !== "completed") {
    throw new SmokeError(
      `${what} ${message.status}: ${message.errorCode ?? "no error code"}: ${message.errorDetail ?? ""}`.trim(),
    );
  }
  if (message.content.trim().length === 0) {
    throw new SmokeError(`${what} is empty`);
  }
  if (REASONING_MARKERS.test(message.content)) {
    throw new SmokeError(
      `${what} inlines reasoning into its content: ${message.content.slice(0, 200)}`,
    );
  }
}

type StreamOutcome = {
  message: AssistantMessage;
  deltas: number;
  /** Times since the send started. */
  firstDeltaMs: number | null;
  totalMs: number;
  /** Absolute times (performance.now()), to compare streams. */
  firstDeltaAt: number | null;
  endedAt: number;
};

/** One send as an event stream; `onCreated` runs when the turn was admitted. */
async function streamSend(
  ctx: Context,
  sessionId: string,
  content: string,
  what: string,
  onCreated: () => void = () => {},
): Promise<StreamOutcome> {
  const started = performance.now();
  const response = await call(ctx, "POST", `/sessions/${sessionId}/messages`, {
    headers: { accept: "text/event-stream" },
    body: { content },
    timeoutMs: ctx.answerTimeoutMs,
  });
  if (response.status !== 200 || response.body === null) {
    throw problem(response.status, await bodyOf(response, what), what);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let deltas = 0;
  let firstDeltaAt: number | null = null;
  let final: AssistantMessage | undefined;
  const seen: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += value;
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");
        const event = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (event === undefined || data === undefined) {
          continue; // a ping comment
        }
        seen.push(event);
        const payload = JSON.parse(data) as { assistantMessage?: AssistantMessage };
        if (event === "message.created") {
          onCreated();
        } else if (event === "delta") {
          deltas += 1;
          firstDeltaAt ??= performance.now();
        } else if (event === "done" || event === "error") {
          final = payload.assistantMessage;
        } else if (event === "message.detached") {
          throw new SmokeError(`${what}: the stream was detached from its generation`);
        }
      }
    }
  } catch (error) {
    if (error instanceof SmokeError) {
      throw error;
    }
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new SmokeError(`${what}: the stream broke after ${seen.length} events (${reason})`);
  }
  if (final === undefined) {
    throw new SmokeError(
      `${what}: the stream ended without done or error (events: ${seen.length === 0 ? "none" : seen.join(", ")})`,
    );
  }
  const endedAt = performance.now();
  return {
    message: final,
    deltas,
    firstDeltaMs: firstDeltaAt === null ? null : Math.round(firstDeltaAt - started),
    totalMs: Math.round(endedAt - started),
    firstDeltaAt,
    endedAt,
  };
}

async function jsonSend(
  ctx: Context,
  sessionId: string,
  waitSeconds: number,
): Promise<SmokeResult["json"]> {
  const what = "JSON answer";
  const started = performance.now();
  const response = await call(ctx, "POST", `/sessions/${sessionId}/messages`, {
    headers: { prefer: `wait=${waitSeconds}` },
    body: { content: QUESTION },
    timeoutMs: (waitSeconds + 30) * 1000,
  });
  const body = await bodyOf(response, what);
  let message = body.assistantMessage as AssistantMessage | undefined;
  if (![200, 202, 502].includes(response.status) || message === undefined) {
    throw problem(response.status, body, what);
  }
  let polls = 0;
  if (response.status === 202) {
    const location = response.headers.get("location");
    if (location === null) {
      throw new SmokeError(`${what}: HTTP 202 without a Location header`);
    }
    ctx.log(`JSON send: HTTP 202 after ${Math.round(performance.now() - started)} ms; polling`);
    const deadline = performance.now() + ctx.answerTimeoutMs;
    while (message.status === "generating") {
      if (performance.now() > deadline) {
        throw new SmokeError(`${what}: still generating after ${ctx.answerTimeoutMs / 1000} s`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      polls += 1;
      const poll = await call(ctx, "GET", location);
      const polled = await bodyOf(poll, `${what} (poll)`);
      if (poll.status !== 200) {
        throw problem(poll.status, polled, `${what} (poll)`);
      }
      message = polled as unknown as AssistantMessage;
    }
  }
  const totalMs = Math.round(performance.now() - started);
  checkAnswer(what, message);
  return { ...report(message), httpStatus: response.status, polls, totalMs };
}

async function limitCheck(
  ctx: Context,
  provider: string,
  concurrency: number,
  maxOutputTokens: number,
): Promise<NonNullable<SmokeResult["limit"]>> {
  const sessions = await Promise.all(
    Array.from({ length: concurrency + 1 }, () => createSession(ctx, provider)),
  );
  const extraSession = sessions.pop() as string;
  let ended = 0;
  const streams = sessions.map((sessionId, index) => {
    let created!: () => void;
    const admitted = new Promise<void>((resolve) => (created = resolve));
    const outcome = streamSend(ctx, sessionId, LONG_QUESTION, `long answer ${index + 1}`, () =>
      created(),
    ).finally(() => (ended += 1));
    return { admitted, outcome };
  });
  // Settles every stream even when a check below fails first: no unhandled rejection.
  const outcomes = Promise.allSettled(streams.map((stream) => stream.outcome));
  await Promise.race([
    Promise.all(streams.map((stream) => stream.admitted)),
    // A stream that fails before it was admitted ends the check with its own error.
    Promise.all(streams.map((stream) => stream.outcome)).then(() => {}),
  ]);
  if (ended > 0) {
    await outcomes;
    throw new SmokeError("a long answer ended before the extra send: ask for a longer answer");
  }

  const extra = await call(ctx, "POST", `/sessions/${extraSession}/messages`, {
    headers: { prefer: "respond-async" },
    body: { content: QUESTION },
  });
  const extraBody = await bodyOf(extra, "extra send");
  const rejected = {
    httpStatus: extra.status,
    code: typeof extraBody.code === "string" ? extraBody.code : null,
    retryAfter: extra.headers.get("retry-after"),
  };
  ctx.log(`extra send while ${concurrency} answers run: ${JSON.stringify(rejected)}`);
  const stillRunning = ended === 0;

  const settled = await outcomes;
  const answers = settled.map((result, index) => {
    if (result.status === "rejected") {
      throw result.reason;
    }
    const what = `long answer ${index + 1}`;
    const { message } = result.value;
    checkAnswer(what, message);
    const tokens = message.usage?.completionTokens;
    if (tokens !== undefined && tokens > maxOutputTokens) {
      throw new SmokeError(
        `${what} went past the output limit: ${tokens} tokens > maxOutputTokens ${maxOutputTokens}`,
      );
    }
    if (message.finishReason !== "length") {
      throw new SmokeError(
        `${what} ended with finish reason ${message.finishReason ?? "none"}, not length: ` +
          "the output limit was not shown to be enforced",
      );
    }
    return {
      ...report(message),
      firstDeltaMs: result.value.firstDeltaMs,
      totalMs: result.value.totalMs,
    };
  });
  if (rejected.httpStatus !== 503 || rejected.code !== "provider_busy") {
    throw new SmokeError(
      `the extra send got HTTP ${rejected.httpStatus} ${rejected.code ?? ""}, not 503 provider_busy` +
        (stillRunning ? "" : " (an answer had ended before it was answered)"),
    );
  }
  const values = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const lastStart = Math.max(...values.map((value) => value.firstDeltaAt ?? Infinity));
  const firstEnd = Math.min(...values.map((value) => value.endedAt));
  return { concurrency, rejected, answers, overlapped: lastStart < firstEnd };
}

export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const ctx: Context = {
    baseUrl: options.baseUrl.replace(/\/+$/, ""),
    answerTimeoutMs: (options.answerTimeoutSeconds ?? 240) * 1000,
    log: options.log ?? ((line) => process.stdout.write(`${line}\n`)),
  };
  const providerId = options.provider ?? "ollama";

  const listed = await call(ctx, "GET", "/providers");
  const listedBody = await bodyOf(listed, "GET /providers");
  if (listed.status !== 200) {
    throw problem(listed.status, listedBody, "GET /providers");
  }
  const providers = (listedBody.providers ?? []) as ProviderInfo[];
  const provider = providers.find((entry) => entry.id === providerId);
  if (provider === undefined) {
    throw new SmokeError(
      `provider "${providerId}" is not enabled at ${ctx.baseUrl} ` +
        `(enabled: ${providers.length === 0 ? "none" : providers.map((entry) => entry.id).join(", ")})`,
    );
  }
  const model = provider.models.find((entry) => entry.id === provider.defaultModel);
  if (model === undefined) {
    throw new SmokeError(`provider "${providerId}" lists no entry for its default model`);
  }
  ctx.log(
    `provider ${providerId}, model ${model.id}: context window ${model.contextWindow}, ` +
      `max output ${model.maxOutputTokens}`,
  );

  const streamed = await streamSend(
    ctx,
    await createSession(ctx, providerId),
    QUESTION,
    "SSE answer",
  );
  checkAnswer("SSE answer", streamed.message);
  const sse = {
    ...report(streamed.message),
    deltas: streamed.deltas,
    firstDeltaMs: streamed.firstDeltaMs,
    totalMs: streamed.totalMs,
  };
  ctx.log(`SSE send: ${JSON.stringify(sse)}`);

  const json = await jsonSend(
    ctx,
    await createSession(ctx, providerId),
    options.jsonWaitSeconds ?? 180,
  );
  ctx.log(`JSON send: ${JSON.stringify(json)}`);

  const result: SmokeResult = {
    provider: providerId,
    model: model.id,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    sse,
    json,
  };
  if (options.limitCheck === true) {
    result.limit = await limitCheck(
      ctx,
      providerId,
      options.concurrency ?? 2,
      model.maxOutputTokens,
    );
    ctx.log(`limit check: ${JSON.stringify(result.limit)}`);
  }
  return result;
}

const USAGE = `Usage: node scripts/smoke-local-llm.ts [options]
  --base-url URL     the API (default http://127.0.0.1:3000)
  --provider ID      the provider to ask (default ollama)
  --json-wait S      Prefer: wait=S for the JSON send (default 180)
  --limit-check      also prove the concurrency limit and the output cap
  --concurrency N    the provider's limit, for --limit-check (default 2)
`;

function wholeNumber(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError(`${name} must be a whole number`);
  }
  return number;
}

async function main(argv: string[]): Promise<number> {
  let options: SmokeOptions;
  try {
    const { values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        "base-url": { type: "string", default: "http://127.0.0.1:3000" },
        "provider": { type: "string", default: "ollama" },
        "json-wait": { type: "string", default: "180" },
        "limit-check": { type: "boolean", default: false },
        "concurrency": { type: "string", default: "2" },
      },
    });
    options = {
      baseUrl: values["base-url"],
      provider: values.provider,
      jsonWaitSeconds: wholeNumber(values["json-wait"], "--json-wait"),
      limitCheck: values["limit-check"],
      concurrency: wholeNumber(values.concurrency, "--concurrency"),
    };
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  try {
    const result = await runSmoke(options);
    process.stdout.write(`SMOKE_RESULT ${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`SMOKE FAILED: ${reason}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(invokedPath)).href
) {
  process.exitCode = await main(process.argv.slice(2));
}
