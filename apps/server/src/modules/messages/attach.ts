import type { Db } from "../../db/client.js";
import type { JobRegistry } from "./jobs.js";
import { findTurn } from "./repository.js";
import type { Turn } from "./schemas.js";

export type Attach = {
  /**
   * The turn's state for a JSON response. With a local job for this attempt, waits until that
   * job has ended (no bound yet); otherwise reads the rows as they are. Undefined when the
   * turn no longer exists (its session was deleted).
   */
  json(assistantId: string, attempt: number): Promise<Turn | undefined>;
};

export function createAttach(deps: { db: Db; jobs: JobRegistry }): Attach {
  const { db, jobs } = deps;
  return {
    async json(assistantId, attempt) {
      const job = jobs.get(assistantId);
      if (job !== undefined && job.attempt === attempt) {
        await job.finished;
      }
      return findTurn(db.drizzle, assistantId);
    },
  };
}
