import { inspect } from "node:util";

const REDACTED = "[REDACTED]";

/**
 * The key of one generation, decided at admission. It lives in a private field, so logging,
 * JSON serialisation or inspecting whatever holds it never shows the value; `reveal()` is the
 * only way to read it, and `clear()` drops it when the generation ends.
 */
export class ApiKey {
  #value: string | null;

  constructor(value: string | null) {
    this.#value = value;
  }

  /** The key, or null for a keyless call or once cleared. */
  reveal(): string | null {
    return this.#value;
  }

  clear(): void {
    this.#value = null;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `ApiKey(${REDACTED})`;
  }
}
