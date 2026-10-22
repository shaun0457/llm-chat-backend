import { z } from "zod";

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

export const sessionIdParams = z.object({ id: z.uuid() });
export const messageParams = z.object({ id: z.uuid(), mid: z.uuid() });

/** Strict: unknown fields are a 400, so later fields cannot be sent to a server ignoring them. */
export const sendMessageBody = z.strictObject({ content });

/** Fastify merges the validated headers over the raw ones, so the other headers stay as sent. */
export const sendMessageHeaders = z.object({
  prefer: z
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
        "Failed assistant messages: llm_upstream_error, llm_timeout (the generation deadline " +
          "passed), cancelled (the server shut down), interrupted (the generation was lost, " +
          "e.g. in a crash, and was failed later)",
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
