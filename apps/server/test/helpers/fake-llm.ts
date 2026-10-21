import { setTimeout as sleep } from "node:timers/promises";

import type {
  LlmEvent,
  LlmFinishReason,
  LlmProvider,
  LlmRequest,
  LlmStreamOptions,
  LlmUsage,
} from "../../src/llm/port.js";

/** What one `stream()` call does. Every field is optional; see FakeLlmProvider. */
export type FakeScript = {
  /** Text chunks, in order. Default ["Hel", "lo"]. */
  deltas?: readonly string[];
  /** Pause before every chunk after the first. */
  delayMs?: number;
  /** Throw an upstream error after emitting this many chunks. */
  throwAfter?: number;
  /** Wait for this promise (or the abort signal) after `gateAfter` chunks. */
  gate?: Promise<void>;
  /** How many chunks to emit before waiting at the gate. Default: all of them. */
  gateAfter?: number;
  /** After the chunks, wait until the signal aborts; never finishes on its own. */
  hang?: boolean;
  /** False: end the stream without a finish event, as a broken upstream might. */
  finish?: boolean;
  finishReason?: LlmFinishReason;
  /** Default { promptTokens: 7, completionTokens: 2 }; null for a provider without usage. */
  usage?: LlmUsage | null;
};

export class FakeUpstreamError extends Error {
  constructor() {
    super("fake upstream failure");
    this.name = "FakeUpstreamError";
  }
}

/** A promise the test resolves when it is ready to let a gated generation continue. */
export function createGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/**
 * A scriptable LLM provider for tests. Each call takes the next queued script (`script()`),
 * or `fallback` once the queue is empty. Records every request and abort signal it receives:
 * the boundary observation tests use to check context assembly and cancellation.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly requests: LlmRequest[] = [];
  readonly signals: AbortSignal[] = [];
  readonly #queue: FakeScript[] = [];

  constructor(
    readonly id = "fake",
    private readonly fallback: FakeScript = {},
  ) {}

  /** Queues scripts for the next calls, in order. */
  script(...scripts: FakeScript[]): this {
    this.#queue.push(...scripts);
    return this;
  }

  stream(request: LlmRequest, options: LlmStreamOptions): AsyncIterable<LlmEvent> {
    this.requests.push(request);
    this.signals.push(options.signal);
    return this.#run(this.#queue.shift() ?? this.fallback, options.signal);
  }

  async *#run(script: FakeScript, signal: AbortSignal): AsyncIterable<LlmEvent> {
    const deltas = script.deltas ?? ["Hel", "lo"];
    const gateAfter = Math.min(script.gateAfter ?? deltas.length, deltas.length);
    for (const [index, text] of deltas.entries()) {
      if (script.gate !== undefined && index === gateAfter) {
        await Promise.race([script.gate, untilAborted(signal)]);
      }
      if (script.throwAfter === index) {
        throw new FakeUpstreamError();
      }
      signal.throwIfAborted();
      if (index > 0 && (script.delayMs ?? 0) > 0) {
        await sleep(script.delayMs, undefined, { signal });
      }
      yield { type: "delta", text };
    }
    if (script.throwAfter !== undefined && script.throwAfter >= deltas.length) {
      throw new FakeUpstreamError();
    }
    if (script.gate !== undefined && gateAfter === deltas.length) {
      await Promise.race([script.gate, untilAborted(signal)]);
    }
    if (script.hang === true) {
      await untilAborted(signal);
    }
    signal.throwIfAborted();
    if (script.finish === false) {
      return;
    }
    yield {
      type: "finish",
      reason: script.finishReason ?? "stop",
      usage: script.usage === undefined ? { promptTokens: 7, completionTokens: 2 } : script.usage,
    };
  }
}
