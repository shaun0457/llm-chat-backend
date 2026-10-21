/** The first string `field` along an error's cause chain (drizzle wraps pg errors as `cause`). */
function causeField(error: unknown, field: "code" | "constraint"): string | undefined {
  const seen = new Set<object>();
  let current: unknown = error;
  // `seen` stops a cause chain that loops back on itself.
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    const value: unknown = (current as Record<string, unknown>)[field];
    if (typeof value === "string") {
      return value;
    }
    seen.add(current);
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

/** The SQLSTATE of a pg error, also when drizzle wraps it as the `cause` of its own error. */
export function pgErrorCode(error: unknown): string | undefined {
  return causeField(error, "code");
}

/** The constraint or index named by a pg integrity error (e.g. a 23505 unique violation). */
export function pgConstraint(error: unknown): string | undefined {
  return causeField(error, "constraint");
}
