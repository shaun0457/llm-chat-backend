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
  sessionIdParams,
  turnResponse,
} from "./schemas.js";
import type { MessagesService } from "./service.js";

const GENERIC_FAILURE_DETAIL = "The answer could not be generated.";
/** Seconds a client should wait before polling an answer that is still being generated. */
const POLL_AFTER_SECONDS = "2";

/** Every `Prefer` line of the request; Node joins repeated lines into one string. */
function preferValues(header: string | string[] | undefined): string[] {
  if (header === undefined) {
    return [];
  }
  return Array.isArray(header) ? header : [header];
}

export const messagesRoutes: FastifyPluginAsyncZod<{
  service: MessagesService;
  jsonWait: WaitConfig;
}> = async (app, { service, jsonWait }) => {
  app.post(
    "/sessions/:id/messages",
    {
      schema: {
        summary: "Send a message and wait for the answer",
        description:
          "Stores the user message and a generating assistant message, then generates the " +
          "answer with the session's provider and model. The response waits until the answer " +
          "is finished: 200 with both messages when it completed, 502 problem details with " +
          "both messages when it failed, 202 with both messages when the server shut down " +
          "before the answer finished. 404 session_not_found; 409 session_busy while an " +
          "earlier answer in the session is still being generated; 422 provider_unavailable " +
          "or model_not_supported when the session's settings no longer resolve; 503 " +
          "server_busy (Retry-After) while the server is shutting down.",
        tags: ["messages"],
        params: sessionIdParams,
        body: sendMessageBody,
        response: {
          200: turnResponse,
          202: turnResponse,
          502: {
            description: "The answer failed",
            content: { "application/problem+json": { schema: failedTurnProblem } },
          },
        },
      },
    },
    async (request, reply) => {
      const preferences = parsePrefer(preferValues(request.headers.prefer));
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
          "being generated. 404 message_not_found unless it belongs to this session.",
        tags: ["messages"],
        params: messageParams,
        response: { 200: messageResponse },
      },
    },
    async (request) => service.get(request.params.id, request.params.mid),
  );
};
