import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseCatalog } from "../../src/llm/catalog.js";
import { createRegistry } from "../../src/llm/registry.js";
import { makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider } from "../helpers/fake-llm.js";
import { allMessages, createSession, send } from "../helpers/messages.js";

const testDb = useTestDatabase();

/**
 * "tiny": a 400-token window with 50 reserved for output and a 40-token margin. An ASCII text
 * of 3n characters estimates at n tokens, and every message sent costs 8 more.
 */
function tinyProvider(llm: FakeLlmProvider) {
  const catalog = parseCatalog(
    {
      providers: {
        tiny: {
          defaultModel: "tiny-1",
          requiresKey: false,
          models: [{ id: "tiny-1", contextWindow: 400, maxOutputTokens: 50 }],
        },
      },
    },
    "budget test catalog",
  );
  const registry = createRegistry(
    catalog,
    { providersEnabled: ["tiny"], defaultProvider: "tiny", defaultModel: undefined },
    { tiny: llm },
  );
  return { catalog, registry };
}

/** 60 characters: 20 tokens. */
const sixty = (label: string) => label.padEnd(60, ".");

describe("history budget", () => {
  let app: FastifyInstance;
  let fake: FakeLlmProvider;

  beforeEach(() => {
    fake = new FakeLlmProvider();
    app = makeTestApp({ db: testDb.db, ...tinyProvider(fake) });
  });
  afterEach(async () => {
    await app.close();
  });

  it("context.trim: sends the newest whole turns that fit, oldest first, then the input", async () => {
    const session = await createSession(app);
    for (let index = 1; index <= 10; index += 1) {
      fake.script({ deltas: [sixty(`A${index}`)] });
      const response = await send(app, session.id, { content: sixty(`Q${index}`) });
      expect(response.statusCode).toBe(200);
    }

    // Budget: 400 − 50 − 40 − ("Final": 2 + 8) = 300. A turn is 20 + 20 + 2 × 8 = 56 tokens,
    // so the newest five (280) fit and the sixth would not.
    const response = await send(app, session.id, { content: "Final" });

    expect(response.statusCode).toBe(200);
    const expected = [6, 7, 8, 9, 10].flatMap((index) => [
      { role: "user", content: sixty(`Q${index}`) },
      { role: "assistant", content: sixty(`A${index}`) },
    ]);
    expect(fake.requests[10]?.messages).toEqual([...expected, { role: "user", content: "Final" }]);
  });

  it("budget: rejects an input that cannot fit the model with 422 input_too_long and writes nothing", async () => {
    const session = await createSession(app);
    // 400 − 50 − 40 − 8 = 302 tokens at most: 906 characters fit, 907 do not.
    const fits = await send(app, session.id, { content: "x".repeat(906) });
    expect(fits.statusCode).toBe(200);
    const before = await allMessages(app, session.id);

    const response = await send(app, session.id, { content: "x".repeat(907) });

    expect(response.statusCode).toBe(422);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({ status: 422, code: "input_too_long" });
    // The system prompt counts too, so the detail names both.
    expect(response.json().detail).toContain("system prompt");
    expect(await allMessages(app, session.id)).toEqual(before);
    expect(fake.requests).toHaveLength(1);
  });
});
