import { setTimeout as sleep } from "node:timers/promises";

import type { LlmEvent, LlmProvider, LlmRequest, LlmStreamOptions } from "./port.js";

/**
 * A keyless provider for trying the API: a fixed sentence with the length of the last user
 * message, streamed word by word with `delayMs` between chunks. Deterministic by design.
 */
export class DemoProvider implements LlmProvider {
  readonly id = "demo";
  readonly #delayMs: number;

  constructor(options: { delayMs: number }) {
    this.#delayMs = options.delayMs;
  }

  async *stream(request: LlmRequest, { signal }: LlmStreamOptions): AsyncIterable<LlmEvent> {
    const input = request.messages.findLast((message) => message.role === "user")?.content ?? "";
    const reply = `This is the demo provider. Your message was ${[...input].length} characters long.`;
    const chunks = reply.match(/\S+\s*/g) ?? [];

    for (const [index, text] of chunks.entries()) {
      signal.throwIfAborted();
      if (index > 0 && this.#delayMs > 0) {
        await sleep(this.#delayMs, undefined, { signal });
      }
      yield { type: "delta", text };
    }
    signal.throwIfAborted();
    yield { type: "finish", reason: "stop", usage: null };
  }
}
