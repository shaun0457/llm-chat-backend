import type { FastifyError, FastifyInstance, FastifyReply } from "fastify";
import { STATUS_CODES } from "node:http";

/** The only way a handler signals an expected error; mapped to RFC 9457 problem details. */
export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ?? code);
    this.name = "ProblemError";
  }
}

export type Problem = {
  type: "about:blank";
  title: string;
  status: number;
  code: string;
  detail?: string;
};

export function problem(status: number, code: string, detail?: string): Problem {
  return {
    type: "about:blank",
    title: STATUS_CODES[status] ?? "Unknown Status",
    status,
    code,
    ...(detail === undefined ? {} : { detail }),
  };
}

export function sendProblem(reply: FastifyReply, body: Problem): FastifyReply {
  return reply.code(body.status).type("application/problem+json").send(JSON.stringify(body));
}

/** "body.content: Invalid input; querystring.limit: Too big" — field paths and reasons only. */
function validationDetail(error: FastifyError): string {
  const context = error.validationContext ?? "request";
  return (error.validation ?? [])
    .map((issue) => {
      const path = issue.instancePath
        .split("/")
        .filter((segment) => segment.length > 0)
        .join(".");
      const location = path.length > 0 ? `${context}.${path}` : context;
      return `${location}: ${issue.message ?? "invalid"}`;
    })
    .join("; ");
}

export function registerProblemDetails(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    return sendProblem(
      reply,
      problem(404, "route_not_found", `${request.method} ${path} does not exist`),
    );
  });

  // Typed as unknown: a handler can throw or reject with anything, including null.
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ProblemError) {
      return sendProblem(reply, problem(error.status, error.code, error.detail));
    }
    if (!(error instanceof Error)) {
      request.log.error({ thrown: typeof error }, "unhandled non-Error thrown");
      return sendProblem(reply, problem(500, "internal_error"));
    }
    const fastifyError = error as FastifyError & { expose?: unknown };
    if (fastifyError.validation !== undefined) {
      return sendProblem(reply, problem(400, "validation_error", validationDetail(fastifyError)));
    }
    // Client errors deliberately raised by Fastify (FST_ERR_*: malformed JSON, oversized body) or
    // by plugins through http-errors (expose: true, e.g. 416 from the static file server) keep
    // their status. Any other error carrying a statusCode (e.g. an unwrapped upstream SDK error)
    // is unexpected and must not leak its status or message.
    const status = fastifyError.statusCode;
    const isClientError =
      (typeof fastifyError.code === "string" && fastifyError.code.startsWith("FST_ERR_")) ||
      fastifyError.expose === true;
    if (isClientError && status !== undefined && status >= 400 && status < 500) {
      const code = status === 400 ? "validation_error" : "request_error";
      return sendProblem(reply, problem(status, code, fastifyError.message));
    }

    request.log.error({ err: error }, "unhandled error");
    return sendProblem(reply, problem(500, "internal_error"));
  });
}
