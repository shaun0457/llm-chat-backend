import type { FastifyBaseLogger } from "fastify";

import type { SseStream } from "../../http/sse.js";
import type { Job, JobRegistry } from "./jobs.js";
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
  /**
   * Streams the turn: `message.created` with both messages as they are now, then
   * - with a local job for this attempt: every later delta exactly once, then `done` or
   *   `error` when the job ends;
   * - otherwise, from the stored row: `done` or `error` when it is terminal, or
   *   `message.detached` when it is generating where this process cannot follow it.
   * Then ends the stream. `known` is the turn as the caller just read or admitted it. Never
   * throws: a failure after the stream started is logged and ends the stream.
   */
  sse(stream: SseStream, assistantId: string, attempt: number, known?: Turn): Promise<void>;
};

const GENERIC_FAILURE_DETAIL = "The answer could not be generated.";

function kindOf(status: Message["status"]): JsonOutcome["kind"] {
  return status === "generating" ? "pending" : status;
}

/** `done` for a completed message, `error` (with its code and detail) for a failed one. */
function sendTerminal(stream: SseStream, message: Message): void {
  if (message.status === "completed") {
    stream.send("done", { assistantMessage: message });
  } else {
    stream.send("error", {
      code: message.errorCode ?? "llm_upstream_error",
      detail: message.errorDetail ?? GENERIC_FAILURE_DETAIL,
      assistantMessage: message,
    });
  }
}

export function createAttach(deps: {
  jobs: Pick<JobRegistry, "get">;
  /** Both rows of the turn this assistant message answers in, as they are now. */
  readTurn: (assistantId: string) => Promise<Turn | undefined>;
  log: FastifyBaseLogger;
}): Attach {
  const { jobs, readTurn, log } = deps;

  const localJob = (assistantId: string, attempt: number): Job | undefined => {
    const job = jobs.get(assistantId);
    return job !== undefined && job.attempt === attempt ? job : undefined;
  };

  /** The stored state only: no live updates. */
  function fromRow(stream: SseStream, turn: Turn): void {
    stream.send("message.created", turn);
    if (turn.assistantMessage.status === "generating") {
      stream.send("message.detached", { assistantMessage: turn.assistantMessage });
    } else {
      sendTerminal(stream, turn.assistantMessage);
    }
    stream.end();
  }

  /** Follows a running job. Call synchronously after looking the job up. */
  async function follow(stream: SseStream, job: Job, turn: Turn): Promise<void> {
    const { id } = turn.assistantMessage;
    const { attempt } = job;
    let ended = false;
    // One synchronous step: the snapshot and the subscription together see every character
    // exactly once, so no delta is lost or repeated between them.
    const content = job.bus.snapshot();
    const unsubscribe = job.bus.subscribe((event) => {
      if (event.type === "delta") {
        stream.send("delta", { id, attempt, text: event.text });
      } else {
        ended = true;
        sendTerminal(stream, event.message);
        stream.end();
      }
    });
    stream.onClose(unsubscribe);
    stream.send("message.created", {
      userMessage: turn.userMessage,
      assistantMessage: { ...turn.assistantMessage, content },
    });

    await job.finished;
    if (ended || stream.closed) {
      return;
    }
    // The job ended without publishing a final state: its turn was deleted or superseded, or
    // storing the final state failed (the row stays generating until stale reclaim).
    const now = await readTurn(id);
    if (now === undefined) {
      stream.end();
      return;
    }
    const message = now.assistantMessage;
    if (message.attempt === attempt && message.status !== "generating") {
      sendTerminal(stream, message);
    } else {
      stream.send("message.detached", { assistantMessage: message });
    }
    stream.end();
  }

  return {
    async json(assistantId, attempt, waitMs) {
      const job = localJob(assistantId, attempt);
      if (job !== undefined) {
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

    async sse(stream, assistantId, attempt, known) {
      try {
        let turn = known ?? (await readTurn(assistantId));
        let job = localJob(assistantId, attempt);
        if (job === undefined && turn?.assistantMessage.status === "generating") {
          // The job may have ended (and stored the final state) since the turn was read.
          turn = await readTurn(assistantId);
          job = localJob(assistantId, attempt);
        }
        if (turn === undefined) {
          stream.end();
          return;
        }
        if (job !== undefined && turn.assistantMessage.status === "generating") {
          await follow(stream, job, turn);
        } else {
          fromRow(stream, turn);
        }
      } catch (error) {
        log.error({ err: error, assistantId }, "streaming a turn failed");
        stream.end();
      }
    },
  };
}
