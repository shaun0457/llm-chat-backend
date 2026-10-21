import { z } from "zod";

const ISO_UTC_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** A real calendar time: rejects "2026-02-31…", which Date would roll over to March. */
function isCalendarTime(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 23) === value.slice(0, 23);
}

const cursorKey = z.strictObject({
  t: z.string().regex(ISO_UTC_MICROS).refine(isCalendarTime),
  id: z.uuid(),
});

/**
 * The keyset position after the last item of a page: its (lastActivityAt, id). `t` keeps the
 * database's microsecond precision; milliseconds would skip or repeat rows sharing one.
 */
export type SessionCursor = z.infer<typeof cursorKey>;

export function encodeCursor(key: SessionCursor): string {
  return Buffer.from(JSON.stringify({ t: key.t, id: key.id })).toString("base64url");
}

/** Undefined for anything that is not a cursor this server issued (or could have). */
export function decodeCursor(cursor: string): SessionCursor | undefined {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const result = cursorKey.safeParse(json);
  return result.success ? result.data : undefined;
}
