import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

import { prefersEventStream } from "../../http/accept.js";
import { ProblemError } from "../../http/problem-details.js";
import { type SseOptions, openSseStream } from "../../http/sse.js";
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
  sseResponse,
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
const varyHeader = {
  type: "string",
  enum: ["Accept"],
  description: "The response form (JSON or event stream) depends on Accept",
};
const noStoreHeader = {
  type: "string",
  enum: ["no-store"],
  description: "The state may change until the answer is completed or failed; never cache it",
};

export const messagesRoutes: FastifyPluginAsyncZod<{
  service: MessagesService;
  jsonWait: WaitConfig;
  sse: SseOptions;
}> = async (app, { service, jsonWait, sse }) => {
  app.post(
    "/sessions/:id/messages",
    {
      // Before validation, so every answer of this route says that Accept chose its form; an
      // event stream keeps it, as headers set before the hijack are copied (sse.ts).
      onRequest: async (_request, reply) => {
        void reply.header("vary", "Accept");
      },
      schema: {
        summary: "Send a message; stream the answer or wait a bounded time for it",
        description:
          "Stores the user message and a generating assistant message, then generates the " +
          "answer with the session's provider and model, or with the body's provider/model " +
          "for this turn only. With Accept: text/event-stream the response is an event " +
          "stream (see the 200 response); errors found before it starts are ordinary problem " +
          "details with the statuses below. Otherwise (JSON) the response waits for the " +
          "answer " +
          "at most the effective wait (Prefer: wait=N, otherwise the server's default wait, " +
          "always capped by its maximum; none with Prefer: respond-async): 200 with both " +
          "messages when it " +
          "completed, 502 problem details with both messages when it failed, 202 with both " +
          "messages when it is still being generated. Generation continues unless the " +
          "server shuts down (the answer then fails as cancelled); the wait only decides the " +
          "response. A repeated send (the body's id names a user message of this session " +
          "with identical content, and the provider/model, where given, of its turn) admits " +
          "nothing: it answers with that turn as it is now, in the same form (200, 502 or 202; " +
          "or the event stream: the snapshot, then live deltas while it is generating), " +
          "without checking the key, the model, the session's activity or capacity. 404 " +
          "session_not_found; 409 session_busy while " +
          "an earlier answer in the session is still being generated; 422 " +
          "message_id_conflict when the id is used by another message (another session, an " +
          "assistant message, different content or a different provider/model), " +
          "provider_unavailable or model_not_supported when the requested or the session's " +
          "pair does not resolve, input_too_long when the message and the system prompt " +
          "cannot fit the model's context window with its output reservation, " +
          "llm_credential_missing when the provider needs a key and neither " +
          "X-LLM-Api-Key nor a server key is available; 400 validation_error for a malformed " +
          "X-LLM-Api-Key (its value is never echoed); 503 with Retry-After: 10, server_busy " +
          "when the server is at its limit of active answers or shutting down, provider_busy " +
          "when the turn's provider is at its limit. Nothing is stored on any of these errors.",
        tags: ["messages"],
        params: sessionIdParams,
        headers: sendMessageHeaders,
        body: sendMessageBody,
        response: {
          200: {
            description:
              "JSON: the answer completed within the wait. Event stream: the answer as it is " +
              "generated (generation failures arrive as an error event, the status stays 200)",
            headers: { "Preference-Applied": preferenceAppliedHeader, "Vary": varyHeader },
            content: {
              "application/json": { schema: turnResponse },
              "text/event-stream": { schema: sseResponse },
            },
          },
          202: {
            description:
              "Admitted; the answer is still being generated. Poll Location until its status " +
              "is completed or failed. A message whose generation was lost (a crash, or a " +
              "final state that could not be stored) is failed as interrupted within a few " +
              "minutes.",
            headers: {
              "Location": {
                type: "string",
                description: "The assistant message to poll: /sessions/{id}/messages/{mid}",
              },
              "Retry-After": { type: "integer", description: "Seconds to wait before polling" },
              "Cache-Control": noStoreHeader,
              "Preference-Applied": preferenceAppliedHeader,
              "Vary": varyHeader,
            },
            content: { "application/json": { schema: turnResponse } },
          },
          502: {
            description: "The answer failed within the wait",
            headers: { "Preference-Applied": preferenceAppliedHeader, "Vary": varyHeader },
            content: { "application/problem+json": { schema: failedTurnProblem } },
          },
        },
      },
    },
    async (request, reply) => {
      if (prefersEventStream(request.headers.accept)) {
        // Prefer applies to JSON responses only.
        await service.sendStreaming(
          request.params.id,
          request.body,
          { apiKey: request.headers["x-llm-api-key"] },
          () => openSseStream(reply, sse),
        );
        return reply;
      }
      // Node joins repeated Prefer lines into one comma-separated value.
      const { prefer } = request.headers;
      const preferences = parsePrefer(prefer === undefined ? [] : [prefer]);
      // The response is not sent before the wait ends, so a close now means the client left.
      const clientGone = new AbortController();
      reply.raw.once("close", () => clientGone.abort());
      const outcome = await service.send(request.params.id, request.body, {
        waitMs: effectiveWaitMs(preferences, jsonWait),
        apiKey: request.headers["x-llm-api-key"],
        clientGone: clientGone.signal,
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

  app.get(
    "/sessions/:id/messages/:mid/events",
    {
      schema: {
        summary: "Follow an answer as an event stream",
        description:
          "Re-attaches to an assistant message's current attempt, whatever the Accept header: " +
          "message.created with both messages as they are now (the text so far), then the " +
          "remaining deltas exactly once and done or error. A message that is already " +
          "completed or failed gets message.created and done or error; one that is being " +
          "generated where this server cannot follow it (another process, or a lost " +
          "generation not yet failed as interrupted) gets message.created and " +
          "message.detached: poll the message instead. The stream then ends. 404 " +
          "session_not_found; message_not_found unless it is an assistant message of this " +
          "session.",
        tags: ["messages"],
        params: messageParams,
        response: {
          200: {
            description: "The answer as an event stream",
            content: { "text/event-stream": { schema: sseResponse } },
          },
        },
      },
    },
    async (request, reply) => {
      await service.events(request.params.id, request.params.mid, () => openSseStream(reply, sse));
      return reply;
    },
  );
};
