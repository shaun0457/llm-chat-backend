/** A comment frame: keeps proxies from closing a stream that is quiet for a while. */
export const PING_FRAME = ": ping\n\n";

/**
 * One server-sent event: `event: <name>`, one `data:` line, a blank line. JSON.stringify escapes
 * CR and LF inside strings, so the payload never spans lines. No `id:` lines: streams are not
 * resumed with Last-Event-ID (a re-attach starts from a snapshot instead).
 */
export function encodeEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}
