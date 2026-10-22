import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { BODY_PROBLEMS, COMMON_PROBLEMS, problemResponses } from "../../http/problem-details.js";
import {
  createSessionBody,
  listSessionsQuery,
  sessionIdParams,
  sessionPage,
  sessionResponse,
  updateSessionBody,
} from "./schemas.js";
import { type SessionsService, sessionNotFound } from "./service.js";

const NOT_FOUND = { 404: "session_not_found" } as const;
const PAIR_UNRESOLVED = {
  422: "provider_unavailable or model_not_supported: the provider/model pair does not resolve",
} as const;

export const sessionsRoutes: FastifyPluginAsyncZod<{ service: SessionsService }> = async (
  app,
  { service },
) => {
  app.post(
    "/sessions",
    {
      schema: {
        summary: "Create a session",
        description:
          "Provider and model default to the server's configuration. Provider only → its " +
          "default model (the configured default model for the default provider); model " +
          "only → the default provider. 422 provider_unavailable or model_not_supported " +
          "when the pair does not resolve.",
        tags: ["sessions"],
        body: createSessionBody,
        response: {
          201: sessionResponse,
          ...problemResponses({
            400: "validation_error: a malformed or invalid body",
            ...BODY_PROBLEMS,
            ...PAIR_UNRESOLVED,
            ...COMMON_PROBLEMS,
          }),
        },
      },
    },
    async (request, reply) => {
      const session = await service.createSession(request.body ?? {});
      return reply.code(201).header("location", `/sessions/${session.id}`).send(session);
    },
  );

  app.get(
    "/sessions",
    {
      schema: {
        summary: "List sessions, most recent activity first",
        description:
          "Keyset pagination on (lastActivityAt desc, id desc). A live list, not a snapshot: " +
          "a session with new activity moves to the first page, so refresh from there.",
        tags: ["sessions"],
        querystring: listSessionsQuery,
        response: {
          200: sessionPage,
          ...problemResponses({
            400: "validation_error: a malformed limit or cursor",
            ...COMMON_PROBLEMS,
          }),
        },
      },
    },
    async (request) => service.listSessions(request.query),
  );

  app.get(
    "/sessions/:id",
    {
      schema: {
        summary: "Read a session",
        description: "404 session_not_found when it does not exist.",
        tags: ["sessions"],
        params: sessionIdParams,
        response: {
          200: sessionResponse,
          ...problemResponses({
            400: "validation_error: the id is not a UUID",
            ...NOT_FOUND,
            ...COMMON_PROBLEMS,
          }),
        },
      },
    },
    async (request) => service.getSession(request.params.id),
  );

  app.patch(
    "/sessions/:id",
    {
      schema: {
        summary: "Change a session's title, provider, model or system prompt",
        description:
          "Affects later turns only. lastActivityAt does not move. 400 for an empty change, " +
          "404 session_not_found, 422 provider_unavailable or model_not_supported.",
        tags: ["sessions"],
        params: sessionIdParams,
        body: updateSessionBody,
        response: {
          200: sessionResponse,
          ...problemResponses({
            400: "validation_error: a malformed id or body, or an empty change",
            ...NOT_FOUND,
            ...BODY_PROBLEMS,
            ...PAIR_UNRESOLVED,
            ...COMMON_PROBLEMS,
          }),
        },
      },
    },
    async (request) => service.updateSession(request.params.id, request.body),
  );

  app.delete(
    "/sessions/:id",
    {
      schema: {
        summary: "Delete a session",
        description: "204 when deleted; 404 session_not_found when it does not exist.",
        tags: ["sessions"],
        params: sessionIdParams,
        response: {
          204: z.null().describe("No content"),
          ...problemResponses({
            400: "validation_error: the id is not a UUID",
            ...NOT_FOUND,
            // Fastify parses a DELETE body too, although this route reads none.
            ...BODY_PROBLEMS,
            ...COMMON_PROBLEMS,
          }),
        },
      },
    },
    async (request, reply) => {
      if ((await service.deleteSession(request.params.id)) === "not_found") {
        throw sessionNotFound();
      }
      return reply.code(204).send(null);
    },
  );
};
