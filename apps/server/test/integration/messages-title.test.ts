import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider } from "../helpers/fake-llm.js";
import { createSession, getSession, send } from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";

const testDb = useTestDatabase();

describe("title", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = makeTestApp({ db: testDb.db, ...testProviders({ llm: new FakeLlmProvider() }) });
  });
  afterEach(async () => {
    await app.close();
  });

  async function titleAfterFirstSend(content: string): Promise<string | null> {
    const session = await createSession(app);
    expect((await send(app, session.id, { content })).statusCode).toBe(200);
    return (await getSession(app, session.id)).title;
  }

  it.each([
    ["a short message as it is", "Plan a trip to Kyoto", "Plan a trip to Kyoto"],
    ["the first line of several", "First line\nSecond line\r\nThird", "First line"],
    ["the first non-blank line", "\n\nHello", "Hello"],
    ["a line after whitespace-only lines", "   \n\t\r\n  Hello there  \nmore", "Hello there"],
    ["collapsed whitespace", "  Plan   a\ttrip  ", "Plan a trip"],
    ["exactly 60 characters untouched", "b".repeat(60), "b".repeat(60)],
    ["61 characters cut to 59 plus an ellipsis", "c".repeat(61), `${"c".repeat(59)}…`],
    ["no space before the ellipsis", `${"x".repeat(58)} ${"y".repeat(20)}`, `${"x".repeat(58)}…`],
  ])("derives %s", async (_name, content, title) => {
    expect(await titleAfterFirstSend(content)).toBe(title);
  });

  it("cuts a long multi-line first message to at most 60 code points ending in …", async () => {
    const title = await titleAfterFirstSend(`${"😀".repeat(70)}\nsecond line`);

    expect(title).toBe(`${"😀".repeat(59)}…`);
    expect([...(title ?? "")]).toHaveLength(60);
  });

  it("never overwrites an existing title", async () => {
    const session = await createSession(app, { title: "Mine" });

    await send(app, session.id, { content: "Something else" });

    const after = await getSession(app, session.id);
    expect(after.title).toBe("Mine");
    expect(after.updatedAt).toBe(session.updatedAt);
  });

  it("keeps the title from the first message on later sends", async () => {
    const session = await createSession(app);
    await send(app, session.id, { content: "First" });

    await send(app, session.id, { content: "Second" });

    expect((await getSession(app, session.id)).title).toBe("First");
  });

  it("derives it again from the next send after PATCH clears it", async () => {
    const session = await createSession(app);
    await send(app, session.id, { content: "First" });
    await app.inject({ method: "PATCH", url: `/sessions/${session.id}`, payload: { title: null } });
    expect((await getSession(app, session.id)).title).toBeNull();

    await send(app, session.id, { content: "Second topic" });

    expect((await getSession(app, session.id)).title).toBe("Second topic");
  });

  it("is set by an admitted send even when its answer fails", async () => {
    const fake = new FakeLlmProvider().script({ throwAfter: 0 });
    await app.close();
    app = makeTestApp({ db: testDb.db, ...testProviders({ llm: fake }) });

    const session = await createSession(app);

    expect((await send(app, session.id, { content: "Doomed question" })).statusCode).toBe(502);
    expect((await getSession(app, session.id)).title).toBe("Doomed question");
  });
});
