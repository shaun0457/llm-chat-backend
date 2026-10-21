import { describe, expect, it } from "vitest";

import { DemoProvider } from "../../src/llm/demo.js";
import type { LlmEvent, LlmRequest } from "../../src/llm/port.js";

const request = (content: string): LlmRequest => ({
  model: "demo",
  maxOutputTokens: 1024,
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: "An earlier question" },
    { role: "assistant", content: "An earlier answer" },
    { role: "user", content },
  ],
});

async function collect(
  iterable: AsyncIterable<LlmEvent>,
): Promise<{ events: LlmEvent[]; error: unknown }> {
  const events: LlmEvent[] = [];
  try {
    for await (const event of iterable) {
      events.push(event);
    }
  } catch (error) {
    return { events, error };
  }
  return { events, error: undefined };
}

describe("DemoProvider", () => {
  it("answers the last user message deterministically in word chunks, then finishes", async () => {
    const demo = new DemoProvider({ delayMs: 0 });

    const { events, error } = await collect(
      demo.stream(request("Hello"), { signal: new AbortController().signal, apiKey: null }),
    );

    expect(error).toBeUndefined();
    expect(events).toEqual([
      { type: "delta", text: "This " },
      { type: "delta", text: "is " },
      { type: "delta", text: "the " },
      { type: "delta", text: "demo " },
      { type: "delta", text: "provider. " },
      { type: "delta", text: "Your " },
      { type: "delta", text: "message " },
      { type: "delta", text: "was " },
      { type: "delta", text: "5 " },
      { type: "delta", text: "characters " },
      { type: "delta", text: "long." },
      { type: "finish", reason: "stop", usage: null },
    ]);
  });

  it("counts characters as code points", async () => {
    const demo = new DemoProvider({ delayMs: 0 });

    const { events } = await collect(
      demo.stream(request("héllo 👋"), { signal: new AbortController().signal, apiKey: null }),
    );

    const text = events.map((event) => (event.type === "delta" ? event.text : "")).join("");
    expect(text).toBe("This is the demo provider. Your message was 7 characters long.");
  });

  it("needs no API key and has the id demo", () => {
    expect(new DemoProvider({ delayMs: 0 }).id).toBe("demo");
  });

  it("stops between chunks once the signal aborts", async () => {
    const demo = new DemoProvider({ delayMs: 20 });
    const controller = new AbortController();
    const events: LlmEvent[] = [];

    let error: unknown;
    try {
      for await (const event of demo.stream(request("Hello"), {
        signal: controller.signal,
        apiKey: null,
      })) {
        events.push(event);
        controller.abort();
      }
    } catch (caught) {
      error = caught;
    }

    expect(events).toEqual([{ type: "delta", text: "This " }]);
    expect(error).toMatchObject({ name: "AbortError" });
  });

  it("emits nothing when the signal is already aborted", async () => {
    const demo = new DemoProvider({ delayMs: 0 });
    const controller = new AbortController();
    controller.abort();

    const { events, error } = await collect(
      demo.stream(request("Hello"), { signal: controller.signal, apiKey: null }),
    );

    expect(events).toEqual([]);
    expect(error).toMatchObject({ name: "AbortError" });
  });
});
