/** The SQLSTATE of a pg error, also when drizzle wraps it as the `cause` of its own error. */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if ("code" in current && typeof current.code === "string") {
      return current.code;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}
