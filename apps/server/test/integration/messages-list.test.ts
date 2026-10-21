import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider } from "../helpers/fake-llm.js";
import { type Message, createSession, getMessage, send } from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";

const testDb = useTestDatabase();

type Page = { items: Message[]; nextBefore: string | null };

const UNKNOWN_ID = "0190f5a0-0000-7000-8000-000000000000";

describe("messages.list and get one", () => {
  let app: FastifyInstance;
  let sessionId: string;
  let otherSessionId: string;
  let otherMessageId: string;

  beforeAll(async () => {
    app = makeTestApp({ db: testDb.db, ...testProviders({ llm: new FakeLlmProvider() }) });
    sessionId = (await createSession(app)).id;
    // 60 turns = 120 messages.
    for (let turn = 1; turn <= 60; turn += 1) {
      expect((await send(app, sessionId, { content: `Question ${turn}` })).statusCode).toBe(200);
    }
    otherSessionId = (await createSession(app)).id;
    otherMessageId = (await send(app, otherSessionId, { content: "Elsewhere" })).json().userMessage
      .id;
  });
  afterAll(async () => {
    await app.close();
  });

  async function page(query: string, session = sessionId) {
    return app.inject({ method: "GET", url: `/sessions/${session}/messages${query}` });
  }

  it("pages 120 messages as 50, 50 and 20, newest page first, ascending within a page", async () => {
    const first = await page("");
    expect(first.statusCode).toBe(200);
    const one: Page = first.json();
    const two: Page = (await page(`?before=${one.nextBefore}`)).json();
    const three: Page = (await page(`?before=${two.nextBefore}`)).json();

    expect(one.items.map((message) => message.seq)).toEqual(range(71, 120));
    expect(two.items.map((message) => message.seq)).toEqual(range(21, 70));
    expect(three.items.map((message) => message.seq)).toEqual(range(1, 20));
    expect(one.nextBefore).toBe(one.items[0]?.id);
    expect(two.nextBefore).toBe(two.items[0]?.id);
    expect(three.nextBefore).toBeNull();
    const ids = [...one.items, ...two.items, ...three.items].map((message) => message.id);
    expect(new Set(ids).size).toBe(120);
  });

  it("returns every message exactly once, in seq order, with the message representation", async () => {
    const all: Page = (await page("?limit=200")).json();

    expect(all.nextBefore).toBeNull();
    expect(all.items.map((message) => message.seq)).toEqual(range(1, 120));
    expect(all.items[0]).toMatchObject({ role: "user", content: "Question 1", attempt: null });
    expect(all.items[1]).toMatchObject({
      role: "assistant",
      content: "Hello",
      status: "completed",
      attempt: 1,
      replyToId: all.items[0]?.id,
    });
  });

  it("honours limit and returns null nextBefore when the page reaches the start", async () => {
    const small: Page = (await page("?limit=3")).json();
    const exact: Page = (await page(`?limit=2&before=${small.items[0]?.id}`)).json();

    expect(small.items.map((message) => message.seq)).toEqual([118, 119, 120]);
    expect(exact.items.map((message) => message.seq)).toEqual([116, 117]);
    const start = (await page("?limit=2&before=" + (await nthId(3)))).json();
    expect(start).toMatchObject({ nextBefore: null });
    expect(start.items.map((message: Message) => message.seq)).toEqual([1, 2]);
  });

  it.each([
    ["a message of another session", () => otherMessageId],
    ["an unknown message", () => UNKNOWN_ID],
  ])("answers before= %s with 404 message_not_found", async (_name, before) => {
    const response = await page(`?before=${before()}`);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "message_not_found" });
  });

  it("answers an unknown session with 404 session_not_found", async () => {
    const response = await page("", UNKNOWN_ID);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "session_not_found" });
  });

  it.each(["?limit=0", "?limit=201", "?limit=abc", "?before=not-a-uuid"])(
    "answers %s with 400 validation_error",
    async (query) => {
      const response = await page(query);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "validation_error" });
    },
  );

  describe("GET /sessions/:id/messages/:mid", () => {
    it("answers a message of another session with 404 message_not_found", async () => {
      const response = await getMessage(app, sessionId, otherMessageId);

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "message_not_found" });
    });

    it("answers an unknown message with 404 message_not_found", async () => {
      const response = await getMessage(app, sessionId, UNKNOWN_ID);

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "message_not_found" });
    });

    it("answers a malformed id with 400 validation_error", async () => {
      const response = await getMessage(app, sessionId, "42");

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "validation_error" });
    });
  });

  async function nthId(seq: number): Promise<string> {
    const all: Page = (await page("?limit=200")).json();
    const message = all.items.find((item) => item.seq === seq);
    if (message === undefined) {
      throw new Error(`no message with seq ${seq}`);
    }
    return message.id;
  }
});

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}
