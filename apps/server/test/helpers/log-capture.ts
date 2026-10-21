import { Writable } from "node:stream";

export type LogCapture = {
  stream: Writable;
  /** Raw log lines, for "the secret appears nowhere" assertions. */
  lines: () => string[];
  /** Parsed JSON log entries. */
  entries: () => Array<Record<string, unknown>>;
};

/** Collects the app's JSON log output in memory; pass `stream` as `logStream` to `buildApp`. */
export function captureLogs(): LogCapture {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      lines.push(
        ...chunk
          .toString()
          .split("\n")
          .filter((line) => line.length > 0),
      );
      callback();
    },
  });

  return {
    stream,
    lines: () => [...lines],
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
