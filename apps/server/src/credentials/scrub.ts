const REDACTED = "[REDACTED]";

/** `Bearer <token>` in any case, with the token's usual characters. */
const BEARER = /\b(bearer)\s+[\w.~+/=-]+/gi;
/** `api_key=…`, `apikey=…`, `api-key=…` and `key=…` query or form values. */
const KEY_PARAM = /([?&;\s]|^)(api[_-]?key|key)=[^&;\s"']+/gi;
/** Key formats that are recognisable without knowing the key. */
const KNOWN_KEY_FORMATS = /\b(?:nvapi-[\w-]{8,}|sk-[\w-]{16,})/g;

/**
 * Removes credentials from text before it is stored, returned or logged: the literal `key`
 * (if any), bearer tokens, key query parameters and recognisable key formats. The literal key
 * goes first, so a pattern can never leave a fragment of it behind.
 */
export function scrub(text: string, key: string | null): string {
  const withoutKey = key === null || key.length === 0 ? text : text.split(key).join(REDACTED);
  return withoutKey
    .replace(BEARER, `$1 ${REDACTED}`)
    .replace(KEY_PARAM, `$1$2=${REDACTED}`)
    .replace(KNOWN_KEY_FORMATS, REDACTED);
}
