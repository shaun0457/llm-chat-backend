/** RFC 9110 qvalue: 0 to 1 with at most three decimals. */
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

type MediaRange = { type: string; subtype: string; q: number };

/** The media ranges of an Accept header; a range with a malformed q is dropped. */
function mediaRanges(accept: string): MediaRange[] {
  const ranges: MediaRange[] = [];
  for (const entry of accept.split(",")) {
    const [range = "", ...parameters] = entry.split(";").map((part) => part.trim().toLowerCase());
    const [type, subtype, ...rest] = range.split("/");
    if (
      type === undefined ||
      type === "" ||
      subtype === undefined ||
      subtype === "" ||
      rest.length > 0
    ) {
      continue;
    }
    const qParameter = parameters.find((parameter) => /^q\s*=/.test(parameter));
    const qText = qParameter?.slice(qParameter.indexOf("=") + 1).trim();
    if (qText !== undefined && !QVALUE.test(qText)) {
      continue;
    }
    ranges.push({ type, subtype, q: qText === undefined ? 1 : Number(qText) });
  }
  return ranges;
}

/**
 * The q the client gives a media type: that of the most specific matching range (the exact
 * type, then type/*, then the any-type range), the highest when several are equally specific;
 * 0 when none matches.
 */
function qualityOf(
  ranges: readonly MediaRange[],
  type: string,
  subtype: string,
  exactOnly: boolean,
): number {
  let best = { specificity: -1, q: 0 };
  for (const range of ranges) {
    const specificity =
      range.type === type && range.subtype === subtype
        ? 2
        : range.type === type && range.subtype === "*"
          ? 1
          : range.type === "*" && range.subtype === "*"
            ? 0
            : -1;
    if (specificity < 0 || (exactOnly && specificity < 2)) {
      continue;
    }
    if (specificity > best.specificity || (specificity === best.specificity && range.q > best.q)) {
      best = { specificity, q: range.q };
    }
  }
  return best.q;
}

/**
 * Whether a send answers as an event stream: only when `text/event-stream` is listed by name
 * with a q above 0 and above the q of `application/json` (which `application/*` and the
 * any-type range also match). Ties, wildcards alone, and a missing or empty Accept answer JSON.
 */
export function prefersEventStream(accept: string | undefined): boolean {
  if (accept === undefined) {
    return false;
  }
  const ranges = mediaRanges(accept);
  const eventStream = qualityOf(ranges, "text", "event-stream", true);
  return eventStream > 0 && eventStream > qualityOf(ranges, "application", "json", false);
}
