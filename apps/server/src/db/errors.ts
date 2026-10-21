/** The SQLSTATE of a pg error, also when drizzle wraps it as the `cause` of its own error. */
export function pgErrorCode(error: unknown): string | undefined {
  const seen = new Set<object>();
  let current: unknown = error;
  // `seen` stops a cause chain that loops back on itself.
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    if ("code" in current && typeof current.code === "string") {
      return current.code;
    }
    seen.add(current);
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}
