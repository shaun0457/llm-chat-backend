import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestApp } from "../helpers/app.js";
import { useTestDatabase } from "../helpers/db.js";

const testDb = useTestDatabase();

describe("DELETE /sessions/:id", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = makeTestApp({ db: testDb.db });
  });
  afterEach(async () => {
    await app.close();
  });

  const createSession = async (): Promise<string> =>
    (await app.inject({ method: "POST", url: "/sessions" })).json().id;

  it("answers 204 with no body, after which the session is gone", async () => {
    const id = await createSession();

    const response = await app.inject({ method: "DELETE", url: `/sessions/${id}` });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    const read = await app.inject({ method: "GET", url: `/sessions/${id}` });
    expect(read.statusCode).toBe(404);
    expect(read.json()).toMatchObject({ code: "session_not_found" });
  });

  it("answers a second delete of the same session with 404 session_not_found", async () => {
    const id = await createSession();
    await app.inject({ method: "DELETE", url: `/sessions/${id}` });

    const again = await app.inject({ method: "DELETE", url: `/sessions/${id}` });

    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({ code: "session_not_found" });
  });

  it("removes the session from the list and leaves the others", async () => {
    const kept = await createSession();
    const removed = await createSession();

    await app.inject({ method: "DELETE", url: `/sessions/${removed}` });

    const list = await app.inject({ method: "GET", url: "/sessions?limit=100" });
    const ids = (list.json().items as Array<{ id: string }>).map((item) => item.id);
    expect(ids).toContain(kept);
    expect(ids).not.toContain(removed);
  });

  it("answers a malformed id with 400 validation_error", async () => {
    const response = await app.inject({ method: "DELETE", url: "/sessions/123" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "validation_error" });
  });
});
