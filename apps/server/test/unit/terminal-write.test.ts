import { describe, expect, it } from "vitest";

import { systemClock } from "../../src/clock.js";
import type { Db, Tx } from "../../src/db/client.js";
import {
  TerminalWriteError,
  writeWithinBudget,
} from "../../src/modules/messages/terminal-write.js";

/**
 * A database whose transactions record what happened: each statement through `execute` (the
 * statement-timeout setup) answers after `setupDelayMs`, and a callback that returns commits
 * while one that throws rolls back.
 */
function recordingDb(setupDelayMs: number) {
  const events: string[] = [];
  const tx = {
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, setupDelayMs));
      events.push("setup");
    },
  } as unknown as Tx;
  let pending: Promise<unknown> = Promise.resolve();
  const db = {
    tx: async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => {
      const run = (async () => {
        try {
          const result = await fn(tx);
          events.push("commit");
          return result;
        } catch (error) {
          events.push("rollback");
          throw error;
        }
      })();
      pending = run.catch(() => {});
      return run;
    },
  } as unknown as Db;
  return { db, events, settled: () => pending };
}

describe("writeWithinBudget", () => {
  it("never writes or commits once the budget ran out while the setup was answering", async () => {
    const BUDGET_MS = 50;
    const recording = recordingDb(BUDGET_MS * 3);
    let writes = 0;

    await expect(
      writeWithinBudget(
        {
          db: recording.db,
          clock: systemClock,
          limits: { statementTimeoutMs: 1_000, budgetMs: BUDGET_MS },
        },
        async () => {
          writes += 1;
          return "written";
        },
      ),
    ).rejects.toBeInstanceOf(TerminalWriteError);
    // The abandoned try goes on until its setup answers; it must then give up.
    await recording.settled();

    expect(writes).toBe(0);
    expect(recording.events).toEqual(["setup", "rollback"]);
  });

  it("rolls back instead of committing when the budget ran out during the write itself", async () => {
    const BUDGET_MS = 50;
    const recording = recordingDb(0);

    await expect(
      writeWithinBudget(
        {
          db: recording.db,
          clock: systemClock,
          limits: { statementTimeoutMs: 1_000, budgetMs: BUDGET_MS },
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, BUDGET_MS * 3));
          return "written";
        },
      ),
    ).rejects.toBeInstanceOf(TerminalWriteError);
    await recording.settled();

    expect(recording.events).toEqual(["setup", "rollback"]);
  });

  it("commits a write that finishes within the budget", async () => {
    const recording = recordingDb(0);

    await expect(
      writeWithinBudget(
        {
          db: recording.db,
          clock: systemClock,
          limits: { statementTimeoutMs: 1_000, budgetMs: 1_000 },
        },
        async () => "written",
      ),
    ).resolves.toBe("written");
    expect(recording.events).toEqual(["setup", "commit"]);
  });
});
