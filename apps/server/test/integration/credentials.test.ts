import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { TEST_OPERATOR_KEY, makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";
import { FakeLlmProvider } from "../helpers/fake-llm.js";
import { allMessages, createSession, getSession, send } from "../helpers/messages.js";
import { testProviders } from "../helpers/providers.js";

const testDb = useTestDatabase();
const HEADER_KEY = "header-key-not-real-55";

describe("credentials", () => {
  let app: FastifyInstance;
  let fake: FakeLlmProvider;

  function start(operatorKeys?: Record<string, string>): FastifyInstance {
    fake = new FakeLlmProvider();
    app = makeTestApp({
      db: testDb.db,
      ...testProviders({ llm: fake }),
      ...(operatorKeys === undefined ? {} : { operatorKeys }),
    });
    return app;
  }

  afterEach(async () => {
    await app.close();
  });

  it("uses the X-LLM-Api-Key header over the operator key", async () => {
    start();
    const session = await createSession(app, { provider: "other" });

    const response = await send(
      app,
      session.id,
      { content: "Hi" },
      { "x-llm-api-key": HEADER_KEY },
    );

    expect(response.statusCode).toBe(200);
    expect(fake.apiKeys).toEqual([HEADER_KEY]);
  });

  it("uses the operator key of the session's provider without a header", async () => {
    start();
    const session = await createSession(app, { provider: "other" });

    const response = await send(app, session.id, { content: "Hi" });

    expect(response.statusCode).toBe(200);
    expect(fake.apiKeys).toEqual([TEST_OPERATOR_KEY]);
  });

  it("generates with no key for a keyless provider", async () => {
    start({});
    const session = await createSession(app, { provider: "demo" });

    const response = await send(app, session.id, { content: "Hi" });

    expect(response.statusCode).toBe(200);
    expect(fake.apiKeys).toEqual([null]);
  });

  it("rejects a provider that needs a key with 422 llm_credential_missing and writes nothing", async () => {
    start({});
    const session = await createSession(app, { provider: "other" });

    const response = await send(app, session.id, { content: "Hi" });

    expect(response.statusCode).toBe(422);
    expect(response.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(response.json()).toMatchObject({ status: 422, code: "llm_credential_missing" });
    expect(await allMessages(app, session.id)).toEqual([]);
    expect(await getSession(app, session.id)).toEqual(session);
    expect(fake.requests).toHaveLength(0);

    // The session stays usable once a key is supplied.
    const retried = await send(app, session.id, { content: "Hi" }, { "x-llm-api-key": HEADER_KEY });
    expect(retried.statusCode).toBe(200);
  });

  it.each([
    ["with a space", "bad key-value"],
    ["longer than 512 characters", "k".repeat(513)],
    ["with a control character", "bad\tkey"],
  ])("rejects a malformed header %s with 400, never echoing it", async (_label, value) => {
    start();
    const session = await createSession(app, { provider: "other" });

    const response = await send(app, session.id, { content: "Hi" }, { "x-llm-api-key": value });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "validation_error" });
    expect(response.body).not.toContain(value);
    expect(response.body).toContain("x-llm-api-key");
    expect(await allMessages(app, session.id)).toEqual([]);
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects an empty header with 400", async () => {
    start();
    const session = await createSession(app, { provider: "other" });

    const response = await send(app, session.id, { content: "Hi" }, { "x-llm-api-key": "" });

    expect(response.statusCode).toBe(400);
    expect(fake.requests).toHaveLength(0);
  });
});
