import type { JobRegistry } from "./jobs.js";
import { withTimeout } from "./race.js";
import type { Message, Turn } from "./schemas.js";

/**
 * What a JSON response reports about a turn: `completed` and `failed` are terminal, `pending`
 * means the answer was still being generated when the wait ended.
 */
export type JsonOutcome = Readonly<{
  kind: "completed" | "failed" | "pending";
  userMessage: Message;
  assistantMessage: Message;
}>;

export type Attach = {
  /**
   * The turn's state for a JSON response. With a local job for this attempt, waits until that
   * job has ended or `waitMs` has passed, whichever comes first; then reads the rows as they
   * are. Undefined when the turn no longer exists (its session was deleted). A job that could
   * not store the final state leaves its row generating: that is reported as pending, and
   * stale reclaim fails the row later.
   */
  json(assistantId: string, attempt: number, waitMs: number): Promise<JsonOutcome | undefined>;
};

function kindOf(status: Message["status"]): JsonOutcome["kind"] {
  return status === "generating" ? "pending" : status;
}

export function createAttach(deps: {
  jobs: Pick<JobRegistry, "get">;
  /** Both rows of the turn this assistant message answers in, as they are now. */
  readTurn: (assistantId: string) => Promise<Turn | undefined>;
}): Attach {
  const { jobs, readTurn } = deps;
  return {
    async json(assistantId, attempt, waitMs) {
      const job = jobs.get(assistantId);
      if (job !== undefined && job.attempt === attempt) {
        await withTimeout(job.finished, waitMs);
      }
      const turn = await readTurn(assistantId);
      if (turn === undefined) {
        return undefined;
      }
      return {
        kind: kindOf(turn.assistantMessage.status),
        userMessage: turn.userMessage,
        assistantMessage: turn.assistantMessage,
      };
    },
  };
}
