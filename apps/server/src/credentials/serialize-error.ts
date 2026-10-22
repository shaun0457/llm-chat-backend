import { scrub } from "./scrub.js";

/** What a logged error looks like. Only these fields are ever written. */
export type SerializedError = {
  type: string;
  message: string;
  /** Empty when the value thrown has no stack. */
  stack: string;
  code?: string | number;
  status?: number;
  /** PostgreSQL integrity errors: which object. Never `detail` or `where`, which hold values. */
  constraint?: string;
  table?: string;
  column?: string;
  cause?: SerializedError;
};

const MAX_CAUSE_DEPTH = 5;
/** drizzle's DrizzleQueryError message: `Failed query: <sql>\nparams: <values>`. */
const QUERY_PARAMS = /(\nparams: )[\s\S]*$/;

function safeText(text: string): string {
  return scrub(text.replace(QUERY_PARAMS, "$1[omitted]"), null);
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

function serialize(error: unknown, seen: Set<unknown>, depth: number): SerializedError {
  if (!(error instanceof Error)) {
    return { type: typeof error, message: "a non-Error value was thrown", stack: "" };
  }
  seen.add(error);
  const record = error as unknown as Record<string, unknown>;
  const message = safeText(error.message);
  // The stack starts with "<name>: <message>"; the raw message must not survive in it.
  const header = `${error.name}: ${error.message}`;
  const rawStack = typeof error.stack === "string" ? error.stack : "";
  const stack = rawStack.startsWith(header)
    ? `${error.name}: ${message}${safeText(rawStack.slice(header.length))}`
    : safeText(rawStack);
  const type =
    typeof error.constructor === "function" && error.constructor.name.length > 0
      ? error.constructor.name
      : "Error";
  const result: SerializedError = { type, message, stack };

  const code = record.code;
  if (typeof code === "string" || typeof code === "number") {
    result.code = code;
  }
  if (typeof record.status === "number") {
    result.status = record.status;
  }
  for (const field of ["constraint", "table", "column"] as const) {
    const value = stringField(record, field);
    if (value !== undefined) {
      result[field] = value;
    }
  }
  if (error.cause !== undefined && !seen.has(error.cause) && depth < MAX_CAUSE_DEPTH) {
    result.cause = serialize(error.cause, seen, depth + 1);
  }
  return result;
}

/**
 * The log serializer for `err`: an allowlist, so credentials nested anywhere in an error
 * (an SDK error's request options or headers, a failed query's parameters, a database error's
 * `detail`) are never written. Messages are scrubbed of bearer tokens, key parameters and
 * recognisable key formats, and drizzle's query parameters are replaced by "[omitted]".
 */
export function serializeError(error: unknown): SerializedError {
  return serialize(error, new Set(), 0);
}
