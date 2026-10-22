import type { FastifyBaseLogger } from "fastify";

import type { Db } from "../../db/client.js";
import { cutoffDaysAgo, inactiveSessionsPage } from "./repository.js";
import type { SessionsService } from "./service.js";

const DEFAULT_BATCH_SIZE = 100;

/** `failed`: candidates whose delete threw; the next run tries them again. */
export type RetentionRun = Readonly<{ deleted: number; skipped: number; failed: number }>;

/** Deletes sessions that have been inactive for a number of days, on an interval. */
export interface Retention {
  /**
   * One run: the cutoff is now minus the retention days (database clock); every session last
   * active before it is deleted through `deleteSession` with that cutoff, which skips a
   * session that became active meanwhile. Batches, oldest first; a candidate whose delete
   * fails is logged and passed over. A run already in progress is joined rather than started
   * twice. Ends early, between candidates, once `stop()` was called.
   */
  runOnce(): Promise<RetentionRun>;
  /** Runs every interval from now on (the timer never keeps the process alive). */
  start(): void;
  /**
   * No more runs until start(): a run in progress ends after its current candidate and is
   * waited for, and runOnce() does nothing meanwhile.
   */
  stop(): Promise<void>;
}

export function createRetention(deps: {
  db: Db;
  sessions: Pick<SessionsService, "deleteSession">;
  days: number;
  intervalMs: number;
  log: FastifyBaseLogger;
  batchSize?: number;
}): Retention {
  const { db, sessions, days, intervalMs, batchSize = DEFAULT_BATCH_SIZE } = deps;
  const log = deps.log.child({ component: "retention" });
  let running: Promise<RetentionRun> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopping = false;

  async function run(): Promise<RetentionRun> {
    const cutoff = await cutoffDaysAgo(db.drizzle, days);
    let deleted = 0;
    let skipped = 0;
    let failed = 0;
    // A keyset walk: every page starts after the last candidate seen, so a skipped or failed
    // one is never selected again in this run and the run always ends.
    let after: { t: string; id: string } | undefined;
    pages: while (!stopping) {
      const page = await inactiveSessionsPage(db.drizzle, { cutoff, after, limit: batchSize });
      for (const candidate of page) {
        if (stopping) {
          break pages;
        }
        try {
          const outcome = await sessions.deleteSession(candidate.id, { inactiveBefore: cutoff });
          if (outcome === "deleted") {
            deleted += 1;
          } else if (outcome === "skipped") {
            skipped += 1;
          }
        } catch (error) {
          failed += 1;
          // The err serializer leaves out a failed query's parameters.
          log.warn({ sessionId: candidate.id, err: error }, "retention could not delete a session");
        }
      }
      const last = page.at(-1);
      if (page.length < batchSize || last === undefined) {
        break;
      }
      after = { t: last.lastActivityAt, id: last.id };
    }
    log.info({ deleted, skipped, failed, retentionDays: days }, "retention run finished");
    return { deleted, skipped, failed };
  }

  const runOnce = (): Promise<RetentionRun> => {
    running ??= run().finally(() => {
      running = undefined;
    });
    return running;
  };

  return {
    runOnce,
    start() {
      if (timer !== undefined) {
        return;
      }
      stopping = false;
      timer = setInterval(() => {
        // A failed run (e.g. the database is unreachable) is logged; the next tick tries again.
        runOnce().catch((error: unknown) => {
          log.error({ err: error }, "retention run failed");
        });
      }, intervalMs);
      timer.unref();
    },
    async stop() {
      stopping = true;
      clearInterval(timer);
      timer = undefined;
      // Its failure is the caller's (runOnce) or was logged by the interval.
      await running?.catch(() => {});
    },
  };
}
