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
 * invalid), and unknown or malformed preferences are ignored: `respond-async=` with an empty
 * or broken value is not honoured, while a well-formed value (which it does not use) is.
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
    if (equals !== -1 && value === undefined) {
      // `name=` followed by neither a token nor a complete quoted string: malformed, ignored.
      continue;
    }

    if (name === "respond-async") {
      respondAsync = true;
    } else if (name === "wait" && value !== undefined && DIGITS.test(value)) {
      waitSeconds = Math.min(Number(value), Number.MAX_SAFE_INTEGER);
    }
  }
  return { respondAsync, waitSeconds };
}

export type WaitConfig = Readonly<{ defaultMs: number; maxMs: number }>;

/**
 * How long a JSON send waits for its answer: none for `respond-async` (it wins over `wait`),
 * otherwise the requested `wait` or the default, never more than the maximum.
 */
export function effectiveWaitMs(preferences: Preferences, cfg: WaitConfig): number {
  if (preferences.respondAsync) {
    return 0;
  }
  const requestedMs =
    preferences.waitSeconds === null ? cfg.defaultMs : preferences.waitSeconds * 1000;
  return Math.min(requestedMs, cfg.maxMs);
}

/**
 * The `Preference-Applied` value (RFC 7240 §3): `respond-async` when it was honoured, otherwise
 * `wait=<seconds actually waited at most>` (the cap, rounded down, when the request asked for
 * more) when a valid wait was sent. Undefined when no preference changed the behaviour.
 */
export function preferenceApplied(preferences: Preferences, cfg: WaitConfig): string | undefined {
  if (preferences.respondAsync) {
    return "respond-async";
  }
  if (preferences.waitSeconds === null) {
    return undefined;
  }
  return `wait=${Math.floor(effectiveWaitMs(preferences, cfg) / 1000)}`;
}
