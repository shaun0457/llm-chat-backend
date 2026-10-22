import { z } from "zod";

import { API_KEY_PATTERN } from "../../credentials/api-key.js";

// Lengths count UTF-16 code units (JavaScript string length), as for sessions. PostgreSQL text
// cannot hold U+0000, so it is rejected here rather than failing the insert.
const content = z
  .string()
  .min(1)
  .max(16_000)
  .refine((value) => value.trim().length > 0, "must not be blank")
  .refine((value) => !value.includes("\u0000"), "must not contain U+0000")
  .describe("1–16,000 characters, not only whitespace, no U+0000");

const timestamp = z
  .string()
  .describe("ISO-8601 UTC with microsecond precision, e.g. 2026-10-21T15:27:10.982364Z");

// Path ids in lower case, as PostgreSQL returns uuid values: compared with stored ids as
// strings (the session of a replayed message) and used as keys of in-memory jobs.
const pathId = () => z.uuid().toLowerCase();
export const sessionIdParams = z.object({ id: pathId() });
export const messageParams = z.object({ id: pathId(), mid: pathId() });

// No length limit: an id that is not catalogued is a 422, whatever its length.
const provider = z
  .string()
  .min(1)
  .describe(
    "This turn only (the session keeps its own): an enabled provider id (GET /providers). " +
      "Alone: that provider's default model, including when it is the session's provider",
  );
const model = z
  .string()
  .min(1)
  .describe(
    "This turn only (the session keeps its own): a model in the catalog of the given " +
      "provider, or of the session's provider when none is given",
  );

// A regex check, unlike a refine, is exported to the OpenAPI document; no flags, because
// JSON Schema patterns carry none.
const NOT_NIL_OR_MAX_UUID =
  /^(?!(?:0{8}-0{4}-0{4}-0{4}-0{12}|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$)/;

/** Strict: unknown fields are a 400, so later fields cannot be sent to a server ignoring them. */
export const sendMessageBody = z.strictObject({
  id: z
    .uuid()
    // Ids are global: a placeholder like the nil UUID would be taken by its first user.
    .regex(NOT_NIL_OR_MAX_UUID, "must not be the nil or max UUID")
    // Canonical like the path ids, should the id ever be compared as a string.
    .toLowerCase()
    // Zod leaves the format out of the document once a string has two patterns. Last: metadata
    // belongs to one schema instance, and every further check makes a new one.
    .meta({ format: "uuid" })
    .optional()
    .describe(
      "Your own id for the user message (any UUID version, not the nil or max UUID; " +
        "generate it at random), which makes the send safe to repeat: the same id with " +
        "identical content (and, when given, the same provider and model) in the same " +
        "session returns the stored turn instead of admitting a new one. Ids are global: one " +
        "used by another message gives 422 message_id_conflict. Case does not matter; ids " +
        "are returned in lower case. Without it the server generates a UUIDv7 and identical " +
        "sends are not deduplicated",
    ),
  content,
  provider: provider.optional(),
  model: model.optional(),
});

/** Fastify merges the validated headers over the raw ones, so the other headers stay as sent. */
export const sendMessageHeaders = z.object({
  "accept": z
    .string()
    .optional()
    .describe(
      "An event stream of the answer when text/event-stream is listed by name with a q " +
        "above 0 and above that of application/json (which application/* and */* also " +
        "match); JSON otherwise, also on a tie or without Accept",
    ),
  "prefer": z
    .string()
    .optional()
    .describe(
      "RFC 7240 preferences for the JSON response. wait=N: wait up to N seconds for the " +
        "answer, capped by the server's maximum (JSON_MAX_WAIT_MS, 195 s unless " +
        "configured); without it the server's default applies (JSON_DEFAULT_WAIT_MS, 30 s " +
        "unless configured); " +
        "respond-async: answer at once without waiting. respond-async wins when both are " +
        "sent. Unknown or malformed preferences are ignored, never an error.",
    ),
  "x-llm-api-key": z
    .string()
    // Validated without echoing the value: the message names the rule only.
    .regex(API_KEY_PATTERN, "must be 1-512 visible ASCII characters")
    .optional()
    .describe(
      "Your own API key for this generation's provider, used only by providers that need a " +
        "key (requiresKey: true): a provider with requiresKey: false never receives it (nor " +
        "the server's key), though a malformed value is still rejected. Used for this one " +
        "generation, then dropped: never stored, logged or returned. Without it the server's " +
        "own key for the provider is used, if it has one.",
    ),
});

export const listMessagesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("Page size, 1–200"),
  before: z
    .uuid()
    .optional()
    .describe("A message id of this session: return only older messages (nextBefore)"),
});

export const messageResponse = z
  .object({
    id: z.uuid(),
    sessionId: z.uuid(),
    seq: z.number().int().describe("Position in the session; the only ordering key"),
    role: z.enum(["user", "assistant"]),
    content: z.string().describe("Partial while generating; kept when the answer failed"),
    status: z.enum(["generating", "completed", "failed"]).describe("User messages: completed"),
    replyToId: z.uuid().nullable().describe("Assistant: the user message it answers"),
    attempt: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe("Assistant: 1 for the first answer, +1 per retry. User: null"),
    errorCode: z
      .string()
      .nullable()
      .describe(
        "Failed assistant messages: llm_auth_failed (the provider rejected the key), " +
          "llm_upstream_error (any other provider failure, including no answer text; also a " +
          "database failure while reading the history), " +
          "llm_timeout (no response in time, or the generation deadline passed), " +
          "llm_context_overflow (the provider said the input is too long for the model), " +
          "cancelled (the server shut down), interrupted (the generation was lost, e.g. in a " +
          "crash, and was failed later)",
      ),
    errorDetail: z.string().nullable().describe("A safe description of the failure"),
    provider: z.string().nullable().describe("Assistant: the provider frozen for this turn"),
    model: z.string().nullable().describe("Assistant: the model frozen for this turn"),
    usage: z
      .object({ promptTokens: z.number().int(), completionTokens: z.number().int() })
      .nullable()
      .describe("Token usage reported by the provider; null when it reported none"),
    finishReason: z.enum(["stop", "length", "other"]).nullable(),
    latencyMs: z.number().int().nullable().describe("Admission to completion, in milliseconds"),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .describe("One shape for both roles; assistant-only fields are null on user messages");

export const turnResponse = z.object({
  userMessage: messageResponse,
  assistantMessage: messageResponse,
});

export const failedTurnProblem = z
  .object({
    type: z.literal("about:blank"),
    title: z.string(),
    status: z.literal(502),
    code: z.string().describe("The assistant message's errorCode"),
    detail: z.string(),
    userMessage: messageResponse,
    assistantMessage: messageResponse,
  })
  .describe("The answer failed: problem details carrying both stored messages");

/** The event stream, for the OpenAPI document only: hijacked replies are never serialised. */
export const sseResponse = z
  .string()
  .describe(
    "Server-sent events, each `event: <name>` plus one `data:` line of JSON: " +
      "message.created { userMessage, assistantMessage } (the snapshot: content so far), " +
      "delta { id, attempt, text } (only text after the snapshot), " +
      "done { assistantMessage } (completed, with usage), " +
      "error { code, detail, assistantMessage } (failed), " +
      "message.detached { assistantMessage } (generating where this server cannot follow " +
      "it; poll the message). A `: ping` comment every 15 s (SSE_PING_INTERVAL_MS). No " +
      "event ids: a reconnecting client re-attaches and gets a fresh snapshot.",
  );

export const messagePage = z.object({
  items: z.array(messageResponse).describe("Ascending seq"),
  nextBefore: z
    .uuid()
    .nullable()
    .describe("Pass as before= for the next older page; null when there is none"),
});

export type Message = z.infer<typeof messageResponse>;
export type Turn = z.infer<typeof turnResponse>;
export type MessagePage = z.infer<typeof messagePage>;
export type SendMessageInput = z.infer<typeof sendMessageBody>;
export type ListMessagesInput = z.infer<typeof listMessagesQuery>;
