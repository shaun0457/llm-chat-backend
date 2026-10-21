import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { expect } from "vitest";

/** The message representation, as the API returns it. */
export type Message = {
  id: string;
  sessionId: string;
  seq: number;
  role: "user" | "assistant";
  content: string;
  status: "generating" | "completed" | "failed";
  replyToId: string | null;
  attempt: number | null;
  errorCode: string | null;
  errorDetail: string | null;
  provider: string | null;
  model: string | null;
  usage: { promptTokens: number; completionTokens: number } | null;
  finishReason: string | null;
  latencyMs: number | null;
  createdAt: string;
  updatedAt: string;
};

export type Session = {
  id: string;
  title: string | null;
  provider: string;
  model: string;
  systemPrompt: string | null;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
};

export async function createSession(
  app: FastifyInstance,
  payload: Record<string, unknown> = {},
): Promise<Session> {
  const response = await app.inject({ method: "POST", url: "/sessions", payload });
  expect(response.statusCode).toBe(201);
  return response.json();
}

export function send(
  app: FastifyInstance,
  sessionId: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: `/sessions/${sessionId}/messages`,
    payload: payload as Record<string, unknown>,
    headers,
  });
}

export async function getSession(app: FastifyInstance, id: string): Promise<Session> {
  const response = await app.inject({ method: "GET", url: `/sessions/${id}` });
  expect(response.statusCode).toBe(200);
  return response.json();
}

export function getMessage(
  app: FastifyInstance,
  sessionId: string,
  messageId: string,
): Promise<LightMyRequestResponse> {
  return app.inject({ method: "GET", url: `/sessions/${sessionId}/messages/${messageId}` });
}

/** Every message of a session, oldest first (pages of 200). */
export async function allMessages(app: FastifyInstance, sessionId: string): Promise<Message[]> {
  const items: Message[] = [];
  let before: string | null = null;
  do {
    const query: string = before === null ? "?limit=200" : `?limit=200&before=${before}`;
    const response = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/messages${query}`,
    });
    expect(response.statusCode).toBe(200);
    const page: { items: Message[]; nextBefore: string | null } = response.json();
    items.unshift(...page.items);
    before = page.nextBefore;
  } while (before !== null);
  return items;
}

/** Polls `read` until `done` holds, failing after `timeoutMs` (generous on purpose). */
export async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `condition not met within ${timeoutMs} ms; last value: ${JSON.stringify(value)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
