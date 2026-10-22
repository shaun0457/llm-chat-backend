import { setTimeout as sleep } from "node:timers/promises";

import type { Clock } from "../../clock.js";
import type { Db, Tx } from "../../db/client.js";
import { pgErrorCode } from "../../db/errors.js";
import { limitStatements } from "../../db/statement-timeout.js";
import { remainingMs } from "./deadline.js";
import { TIMED_OUT, withTimeout } from "./race.js";

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

/**
 * `promise`, or a BudgetExhausted rejection once `ms` have passed first; `abandon` is then
 * called before the rejection, so the try can see that it must not write or commit any more.
 */
async function within<T>(promise: Promise<T>, ms: number, abandon: () => void): Promise<T> {
  // A try abandoned here still ends on its own (at its statement timeout, V2); withTimeout
  // keeps its later rejection from surfacing as unhandled.
  const result = await withTimeout(promise, ms);
  if (result === TIMED_OUT) {
    abandon();
    throw new BudgetExhausted();
  }
  return result;
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
 * and committing, to what is left. The try checks the budget again after every awaited step
 * and before it starts its COMMIT, and rolls back once the budget ran out; only a COMMIT
 * already in flight can still land after the caller was told the write failed (the row is
 * then terminal, and reclaim leaves it alone). A backoff that could not end within the budget
 * is not started, and an error that would repeat on every try (bad data) ends it at once.
 * Throws TerminalWriteError when it gives up.
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
    // Set when the race below gives up on this try: from then on it rolls back.
    let abandoned = false;
    // Checked after every awaited step and before the write and the COMMIT: a try whose
    // budget ran out while it waited (for a connection, for the setup to answer, for the write)
    // must not start writing or commit after its failure may have been reported.
    const ensureTimeLeft = (): number => {
      const ms = abandoned ? 0 : left();
      if (ms === 0) {
        throw new BudgetExhausted();
      }
      return ms;
    };
    try {
      return await within(
        db.tx(async (tx) => {
          await limitStatements(tx, Math.min(limits.statementTimeoutMs, ensureTimeLeft()));
          ensureTimeLeft();
          const result = await write(tx);
          ensureTimeLeft();
          return result;
        }),
        available,
        () => {
          abandoned = true;
        },
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
