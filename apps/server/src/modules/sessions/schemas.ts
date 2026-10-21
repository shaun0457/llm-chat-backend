import { z } from "zod";

import { decodeCursor } from "./cursor.js";

// Lengths count UTF-16 code units (JavaScript string length). Strings are stored untrimmed.
// PostgreSQL text cannot hold U+0000, so it is rejected here rather than failing the insert.
const noNul = (value: string) => !value.includes("\u0000");
const title = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0, "must not be blank")
  .refine(noNul, "must not contain U+0000")
  .describe("1–200 characters, not only whitespace, no U+0000");
const systemPrompt = z
  .string()
  .min(1)
  .max(8000)
  .refine(noNul, "must not contain U+0000")
  .describe("1–8,000 characters, no U+0000");
// No length limit: an id that is not catalogued is a 422, whatever its length.
const provider = z.string().min(1).describe("An enabled provider id (GET /providers)");
const model = z.string().min(1).describe("A model in that provider's catalog");

const timestamp = z
  .string()
  .describe("ISO-8601 UTC with microsecond precision, e.g. 2026-10-21T15:27:10.982364Z");

export const sessionIdParams = z.object({ id: z.uuid() });

// Fastify passes `null` as the body of a request without one.
export const createSessionBody = z
  .object({
    title: title.optional(),
    provider: provider.optional(),
    model: model.optional(),
    systemPrompt: systemPrompt.optional(),
  })
  .nullish();

export const sessionResponse = z.object({
  id: z.uuid(),
  title: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  systemPrompt: z.string().nullable(),
  lastActivityAt: timestamp.describe(
    "ISO-8601 UTC with microsecond precision. Moves when a turn is sent; settings changes " +
      "do not move it",
  ),
  createdAt: timestamp,
  updatedAt: timestamp,
});

const updatableFields = ["title", "provider", "model", "systemPrompt"] as const;

export const updateSessionBody = z
  .object({
    title: title.nullable().optional().describe("null clears it"),
    provider: provider
      .optional()
      .describe(
        "Alone: a different provider's default model; the current provider keeps the model",
      ),
    model: model.optional().describe("Alone: validated against the current provider"),
    systemPrompt: systemPrompt.nullable().optional().describe("null clears it"),
  })
  .refine((body) => updatableFields.some((field) => body[field] !== undefined), {
    message: `at least one of ${updatableFields.join(", ")}`,
  });

export const listSessionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20).describe("Page size, 1–100"),
  cursor: z
    .string()
    .max(200)
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) {
        return undefined;
      }
      const decoded = decodeCursor(value);
      if (decoded === undefined) {
        ctx.addIssue({ code: "custom", message: "not a valid cursor" });
        return z.NEVER;
      }
      return decoded;
    })
    .describe("nextCursor from the previous page; omit for the first page"),
});

export const sessionPage = z.object({
  items: z.array(sessionResponse),
  nextCursor: z.string().nullable().describe("null on the last page"),
});

export type Session = z.infer<typeof sessionResponse>;
export type SessionPage = z.infer<typeof sessionPage>;
export type CreateSessionInput = NonNullable<z.infer<typeof createSessionBody>>;
export type UpdateSessionInput = z.infer<typeof updateSessionBody>;
