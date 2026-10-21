import type { FastifyBaseLogger, FastifyError, FastifyInstance, FastifyReply } from "fastify";
import { STATUS_CODES } from "node:http";

/** Extra members of one problem type (RFC 9457 §3.2); they never replace the standard ones. */
export type ProblemExtensions = Readonly<Record<string, unknown>>;

/** The only way a handler signals an expected error; mapped to RFC 9457 problem details. */
export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
    readonly extensions?: ProblemExtensions,
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
  [extension: string]: unknown;
};

export function problem(
  status: number,
  code: string,
  detail?: string,
  extensions: ProblemExtensions = {},
): Problem {
  return {
    ...extensions,
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

  app.setErrorHandler((error: unknown, request, reply) =>
    sendProblem(reply, toProblem(error, request.log)),
  );
}

/**
 * Maps anything thrown to a problem. Typed as unknown: a handler can throw anything, even null.
 * Client errors keep their status: Fastify's own (FST_ERR_*: malformed JSON, oversized body,
 * bad URL) with their message, and http-errors ones from plugins (expose: true, e.g. 416 from
 * the static file server) without it, since any library can create those. Everything else is
 * unexpected: logged, and answered as 500 without status or message of its own.
 */
export function toProblem(error: unknown, log: FastifyBaseLogger): Problem {
  if (error instanceof ProblemError) {
    return problem(error.status, error.code, error.detail, error.extensions);
  }
  if (!(error instanceof Error)) {
    log.error({ thrown: typeof error }, "unhandled non-Error thrown");
    return problem(500, "internal_error");
  }

  const fastifyError = error as FastifyError & { expose?: unknown };
  if (fastifyError.validation !== undefined) {
    return problem(400, "validation_error", validationDetail(fastifyError));
  }
  const status = fastifyError.statusCode;
  if (status !== undefined && status >= 400 && status < 500) {
    const code = status === 400 ? "validation_error" : "request_error";
    if (typeof fastifyError.code === "string" && fastifyError.code.startsWith("FST_ERR_")) {
      return problem(status, code, fastifyError.message);
    }
    if (fastifyError.expose === true) {
      return problem(status, code);
    }
  }

  log.error({ err: error }, "unhandled error");
  return problem(500, "internal_error");
}
