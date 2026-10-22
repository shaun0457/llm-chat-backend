export const REDACTED = "[REDACTED]";

/**
 * `Bearer <token>` in any case. The token must contain a digit or symbol, so that prose such
 * as "missing bearer token" stays readable; real tokens and keys always do.
 */
const BEARER = /\b(bearer)\s+(?=[a-z]*[\d.~+/=_-])[\w.~+/=-]+/gi;
/** `api_key=…`, `apikey=…`, `api-key=…` and `key=…` query or form values. */
const KEY_PARAM = /([?&;\s]|^)(api[_-]?key|key)=[^&;\s"']+/gi;
/** Key formats that are recognisable without knowing the key, also partially masked. */
const KNOWN_KEY_FORMATS = /\b(?:nvapi-[\w-]{8,}|sk-[\w-]{16,}|(?:nvapi|sk)-[\w-]*\*[\w*-]*)/g;
/**
 * The quoted value after the word `account`, as in NVIDIA's 404 text `Function '<id>': Not
 * found for account '<account id>'`. Not a credential, but sessions are unauthenticated, so
 * anyone holding a session id could read the provider account it names.
 */
const ACCOUNT_ID = /\b(account\s+)(['"])[^'"\r\n]{0,256}\2/gi;

/**
 * Removes credentials from text before it is stored, returned or logged: the literal `key`
 * (if any, also JSON-escaped or URL-encoded), bearer tokens, key query parameters,
 * recognisable key formats and upstream account identifiers. The literal key goes first, so
 * a pattern can never leave a fragment of it behind.
 */
export function scrub(text: string, key: string | null): string {
  let withoutKey = text;
  if (key !== null && key.length > 0) {
    // Also as a JSON string or a URL would carry it; the longest form first.
    const forms = [...new Set([key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key)])];
    for (const form of forms.sort((a, b) => b.length - a.length)) {
      withoutKey = withoutKey.split(form).join(REDACTED);
    }
  }
  return withoutKey
    .replace(BEARER, `$1 ${REDACTED}`)
    .replace(KEY_PARAM, `$1$2=${REDACTED}`)
    .replace(KNOWN_KEY_FORMATS, REDACTED)
    .replace(ACCOUNT_ID, `$1$2${REDACTED}$2`);
}
