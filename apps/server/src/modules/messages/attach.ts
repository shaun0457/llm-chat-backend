import type { JobEnd, JobRegistry } from "./jobs.js";
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
   * are. Undefined when the turn no longer exists (its session was deleted). Throws when the
   * job could not store the answer's final state: the row would claim to be generating
   * although nothing is.
   */
  json(assistantId: string, attempt: number, waitMs: number): Promise<JsonOutcome | undefined>;
};

const TIMED_OUT = "timed_out";

/** The job's end, or TIMED_OUT once `waitMs` passed first. The timer never outlives the call. */
async function endWithin(
  finished: Promise<JobEnd>,
  waitMs: number,
): Promise<JobEnd | typeof TIMED_OUT> {
  if (waitMs <= 0) {
    return TIMED_OUT;
  }
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(resolve, waitMs, TIMED_OUT);
  });
  try {
    return await Promise.race([finished, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

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
        if ((await endWithin(job.finished, waitMs)) === "write_failed") {
          throw new Error("the answer's final state could not be stored");
        }
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
