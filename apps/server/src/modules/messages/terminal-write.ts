import { sql } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";

import type { Clock } from "../../clock.js";
import type { Db, Tx } from "../../db/client.js";
import { pgErrorCode } from "../../db/errors.js";
import { remainingMs } from "./deadline.js";

/** The first pause between tries; it doubles after every failed try (100, 200, 400 … ms). */
const FIRST_BACKOFF_MS = 100;

/**
 * SQLSTATE classes that fail the same way on every try: data exceptions (22), integrity
 * constraint violations (23) and syntax or access errors (42). Everything else (timeouts,
 * lost connections, serialization failures, a busy server) is worth another try.
 */
const PERMANENT_CLASSES = new Set(["22", "23", "42"]);
const isPermanent = (error: unknown): boolean =>
  PERMANENT_CLASSES.has(pgErrorCode(error)?.slice(0, 2) ?? "");

/** Every try failed or the budget ran out; the row is left for stale reclaim. */
export class TerminalWriteError extends Error {
  constructor(
    /** How many tries were started. */
    readonly attempts: number,
    options: { cause: unknown },
  ) {
    super(`the terminal write did not succeed within its budget (${attempts} tries)`, options);
    this.name = "TerminalWriteError";
  }
}

class BudgetExhausted extends Error {
  constructor() {
    super("the terminal-write budget ran out during a try");
    this.name = "BudgetExhausted";
  }
}

/** `promise`, or a rejection once `ms` have passed; the timer never outlives the call. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  // A try abandoned here still ends on its own (at its statement timeout, V2); its outcome is
  // then of no interest, but must not surface as an unhandled rejection.
  promise.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BudgetExhausted()), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export type TerminalWriteLimits = {
  /** Upper limit of each statement of one try. */
  statementTimeoutMs: number;
  /** Limit of the whole operation: connection, transaction, statements and backoff. */
  budgetMs: number;
};

/**
 * Runs `write` (a fenced terminal update) in its own short transaction, retrying failed tries
 * with doubling backoff, all within one absolute budget measured on `clock`. Each try's
 * statements are limited to the smaller of the statement timeout and what is left of the
 * budget (`SET LOCAL statement_timeout`), and the whole try, including getting a connection
 * and committing, to what is left. A backoff that could not end within the budget is not
 * started, and an error that would repeat on every try (bad data) ends it at once. Throws
 * TerminalWriteError when it gives up.
 */
export async function writeWithinBudget<T>(
  deps: { db: Db; clock: Clock; limits: TerminalWriteLimits },
  write: (tx: Tx) => Promise<T>,
): Promise<T> {
  const { db, clock, limits } = deps;
  const started = clock.monotonicNow();
  const left = () => remainingMs(limits.budgetMs, started, clock.monotonicNow());
  let attempts = 0;
  let lastError: unknown;
  let backoffMs = FIRST_BACKOFF_MS;

  for (;;) {
    const available = left();
    if (available === 0) {
      break;
    }
    attempts += 1;
    try {
      return await within(
        db.tx(async (tx) => {
          // Measured again once the try has its connection: a try the race below abandoned
          // while it waited for one must not write after the budget (it rolls back instead).
          const statementMs = Math.min(limits.statementTimeoutMs, left());
          if (statementMs === 0) {
            throw new BudgetExhausted();
          }
          await tx.execute(
            sql`SELECT set_config('statement_timeout', ${`${statementMs}ms`}, true)`,
          );
          return write(tx);
        }),
        available,
      );
    } catch (error) {
      lastError = error;
      if (isPermanent(error)) {
        break;
      }
    }
    // Ends with the last error even if an immediate try might still fit: a backoff that
    // cannot finish within the budget means the next try would have almost no time anyway.
    if (backoffMs >= left()) {
      break;
    }
    await sleep(backoffMs);
    backoffMs *= 2;
  }
  throw new TerminalWriteError(attempts, { cause: lastError });
}
