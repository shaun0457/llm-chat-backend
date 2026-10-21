/**
 * The `Prefer` request header (RFC 7240) as far as JSON sends use it: `respond-async` and
 * `wait`. Preferences are advisory, so nothing here ever rejects a request: whatever cannot be
 * understood is ignored.
 */
export type Preferences = Readonly<{
  /** `respond-async` was present: answer without waiting for the generation. */
  respondAsync: boolean;
  /** The first `wait` preference, in seconds, when it was a non-negative integer. */
  waitSeconds: number | null;
}>;

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const DIGITS = /^\d+$/;

/** Splits at `separator` outside quoted strings; a backslash escapes one character inside them. */
function splitOutsideQuotes(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quoted && char === "\\") {
      current += char + text.charAt(index + 1);
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if (char === separator && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/** A token or a complete quoted string (unescaped); undefined for anything else. */
function wordValue(raw: string): string | undefined {
  if (TOKEN.test(raw)) {
    return raw;
  }
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) {
    return undefined;
  }
  let value = "";
  for (let index = 1; index < raw.length - 1; index += 1) {
    const char = raw.charAt(index);
    if (char === '"') {
      return undefined;
    }
    if (char === "\\") {
      index += 1;
      if (index >= raw.length - 1) {
        return undefined;
      }
      value += raw.charAt(index);
    } else {
      value += char;
    }
  }
  return value;
}

/**
 * Parses every `Prefer` header line of a request (RFC 7240 §2): the lines are joined by commas;
 * each preference is `token [= value]` followed by `;` parameters, which are ignored. Names are
 * case-insensitive, only the first occurrence of a preference counts (even when its value is
 * invalid), and unknown or malformed preferences are ignored.
 */
export function parsePrefer(headerValues: readonly string[]): Preferences {
  const seen = new Set<string>();
  let respondAsync = false;
  let waitSeconds: number | null = null;

  for (const element of splitOutsideQuotes(headerValues.join(","), ",")) {
    const [preference = ""] = splitOutsideQuotes(element, ";");
    const equals = preference.indexOf("=");
    const name = (equals === -1 ? preference : preference.slice(0, equals)).trim().toLowerCase();
    if (!TOKEN.test(name) || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const value = equals === -1 ? undefined : wordValue(preference.slice(equals + 1).trim());

    if (name === "respond-async") {
      respondAsync = true;
    } else if (name === "wait" && value !== undefined && DIGITS.test(value)) {
      waitSeconds = Math.min(Number(value), Number.MAX_SAFE_INTEGER);
    }
  }
  return { respondAsync, waitSeconds };
}
