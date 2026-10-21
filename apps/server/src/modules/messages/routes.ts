import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

import { ProblemError } from "../../http/problem-details.js";
import { type WaitConfig, effectiveWaitMs, parsePrefer, preferenceApplied } from "./prefer.js";
import {
  failedTurnProblem,
  listMessagesQuery,
  messagePage,
  messageParams,
  messageResponse,
  sendMessageBody,
  sendMessageHeaders,
  sessionIdParams,
  turnResponse,
} from "./schemas.js";
import type { MessagesService } from "./service.js";

const GENERIC_FAILURE_DETAIL = "The answer could not be generated.";
/** Seconds a client should wait before polling an answer that is still being generated. */
const POLL_AFTER_SECONDS = "2";

/** Response headers, for the OpenAPI document only (see registerApiDocs). */
const preferenceAppliedHeader = {
  type: "string",
  description:
    "The preferences honoured: respond-async, or wait=<seconds waited at most> (the cap " +
    "when the request asked for more). Absent when none applied. Not a completion guarantee.",
};
const noStoreHeader = {
  type: "string",
  enum: ["no-store"],
  description: "The state may change until the answer is completed or failed; never cache it",
};

export const messagesRoutes: FastifyPluginAsyncZod<{
  service: MessagesService;
  jsonWait: WaitConfig;
}> = async (app, { service, jsonWait }) => {
  app.post(
    "/sessions/:id/messages",
    {
      schema: {
        summary: "Send a message and wait a bounded time for the answer",
        description:
          "Stores the user message and a generating assistant message, then generates the " +
          "answer with the session's provider and model. The response waits for the answer " +
          "at most the effective wait (Prefer: wait=N, otherwise the server's default wait, " +
          "always capped by its maximum; none with Prefer: respond-async): 200 with both " +
          "messages when it " +
          "completed, 502 problem details with both messages when it failed, 202 with both " +
          "messages when it is still being generated. Generation continues unless the " +
          "server shuts down; the wait only decides the response. 404 session_not_found; 409 session_busy while " +
          "an earlier answer in the session is still being generated; 422 " +
          "provider_unavailable or model_not_supported when the session's settings no longer " +
          "resolve; 503 server_busy (Retry-After) while the server is shutting down.",
        tags: ["messages"],
        params: sessionIdParams,
        headers: sendMessageHeaders,
        body: sendMessageBody,
        response: {
          200: {
            description: "The answer completed within the wait",
            headers: { "Preference-Applied": preferenceAppliedHeader },
            content: { "application/json": { schema: turnResponse } },
          },
          202: {
            description:
              "Admitted; the answer is still being generated. Poll Location until its status " +
              "is completed or failed. Also returned when the server shuts down during the " +
              "wait; that generation is stopped and the message stays generating until the " +
              "server marks it failed.",
            headers: {
              "Location": {
                type: "string",
                description: "The assistant message to poll: /sessions/{id}/messages/{mid}",
              },
              "Retry-After": { type: "integer", description: "Seconds to wait before polling" },
              "Cache-Control": noStoreHeader,
              "Preference-Applied": preferenceAppliedHeader,
            },
            content: { "application/json": { schema: turnResponse } },
          },
          502: {
            description: "The answer failed within the wait",
            headers: { "Preference-Applied": preferenceAppliedHeader },
            content: { "application/problem+json": { schema: failedTurnProblem } },
          },
        },
      },
    },
    async (request, reply) => {
      // Node joins repeated Prefer lines into one comma-separated value.
      const { prefer } = request.headers;
      const preferences = parsePrefer(prefer === undefined ? [] : [prefer]);
      const outcome = await service.send(request.params.id, request.body, {
        waitMs: effectiveWaitMs(preferences, jsonWait),
      });
      const applied = preferenceApplied(preferences, jsonWait);
      const headers: Record<string, string> =
        applied === undefined ? {} : { "preference-applied": applied };
      const { userMessage, assistantMessage } = outcome;
      const turn = { userMessage, assistantMessage };

      switch (outcome.kind) {
        case "completed":
          return reply.code(200).headers(headers).send(turn);
        case "failed":
          throw new ProblemError(
            502,
            assistantMessage.errorCode ?? "llm_upstream_error",
            assistantMessage.errorDetail ?? GENERIC_FAILURE_DETAIL,
            turn,
            headers,
          );
        case "pending":
          // Generation goes on; the client polls the assistant message.
          return reply
            .code(202)
            .headers({
              ...headers,
              "location": `/sessions/${assistantMessage.sessionId}/messages/${assistantMessage.id}`,
              "retry-after": POLL_AFTER_SECONDS,
              "cache-control": "no-store",
            })
            .send(turn);
        default: {
          const unknownKind: never = outcome.kind;
          throw new Error(`unhandled JSON outcome: ${String(unknownKind)}`);
        }
      }
    },
  );

  app.get(
    "/sessions/:id/messages",
    {
      schema: {
        summary: "List a session's messages, newest page first",
        description:
          "Pages backwards from the newest message; items within a page are in ascending seq. " +
          "Pass nextBefore as before= for the next older page. 404 session_not_found, or " +
          "message_not_found when before is not a message of this session.",
        tags: ["messages"],
        params: sessionIdParams,
        querystring: listMessagesQuery,
        response: { 200: messagePage },
      },
    },
    async (request) => service.list(request.params.id, request.query),
  );

  app.get(
    "/sessions/:id/messages/:mid",
    {
      schema: {
        summary: "Read one message",
        description:
          "The current state of a message, including the partial content of an answer still " +
          "being generated; the polling target of a 202. Never cached (no-store). 404 " +
          "message_not_found unless it belongs to this session.",
        tags: ["messages"],
        params: messageParams,
        response: {
          200: {
            description: "The message as it is now",
            headers: { "Cache-Control": noStoreHeader },
            content: { "application/json": { schema: messageResponse } },
          },
        },
      },
    },
    async (request, reply) => {
      // The poll target of a 202: never answer from a cache. Set before the lookup so that a
      // 404 is not cached either.
      void reply.header("cache-control", "no-store");
      return service.get(request.params.id, request.params.mid);
    },
  );
};
