import type { FastifyBaseLogger } from "fastify";

import type { Db } from "../../db/client.js";
import { cutoffDaysAgo, inactiveSessionsPage } from "./repository.js";
import type { SessionsService } from "./service.js";

const DEFAULT_BATCH_SIZE = 100;

export type RetentionRun = Readonly<{ deleted: number; skipped: number }>;

/** Deletes sessions that have been inactive for a number of days, on an interval. */
export interface Retention {
  /**
   * One run: the cutoff is now minus the retention days (database clock); every session last
   * active before it is deleted through `deleteSession` with that cutoff, which skips a
   * session that became active meanwhile. Batches, oldest first. A run already in progress
   * is joined rather than started twice.
   */
  runOnce(): Promise<RetentionRun>;
  /** Runs every interval from now on (the timer never keeps the process alive). */
  start(): void;
  /** No more runs; waits for one in progress. */
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

  async function run(): Promise<RetentionRun> {
    const cutoff = await cutoffDaysAgo(db.drizzle, days);
    let deleted = 0;
    let skipped = 0;
    let after: { t: string; id: string } | undefined;
    for (;;) {
      const page = await inactiveSessionsPage(db.drizzle, { cutoff, after, limit: batchSize });
      for (const candidate of page) {
        const outcome = await sessions.deleteSession(candidate.id, { inactiveBefore: cutoff });
        if (outcome === "deleted") {
          deleted += 1;
        } else if (outcome === "skipped") {
          skipped += 1;
        }
      }
      const last = page.at(-1);
      if (page.length < batchSize || last === undefined) {
        break;
      }
      after = { t: last.lastActivityAt, id: last.id };
    }
    log.info({ deleted, skipped, retentionDays: days }, "retention run finished");
    return { deleted, skipped };
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
      timer = setInterval(() => {
        // A failed run is logged; the next tick tries again.
        runOnce().catch((error: unknown) => {
          log.error({ err: error }, "retention run failed");
        });
      }, intervalMs);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await running?.catch(() => {});
    },
  };
}
