import type { FastifyBaseLogger } from "fastify";
import { setTimeout as sleep } from "node:timers/promises";

import type { Clock } from "../../clock.js";
import type { AppConfig } from "../../config.js";
import type { ApiKey } from "../../credentials/api-key.js";
import type { Db, Tx } from "../../db/client.js";
import { pgErrorCode } from "../../db/errors.js";
import { limitStatements } from "../../db/statement-timeout.js";
import { failureOf } from "../../llm/errors.js";
import type { LlmFinishReason, LlmProvider, LlmUsage } from "../../llm/port.js";
import { type MessageBus, createBus } from "./bus.js";
import { assembleContext } from "./context.js";
import { remainingMs } from "./deadline.js";
import { untilAbort, withTimeout } from "./race.js";
import {
  completeAssistant,
  failAssistant,
  findMessage,
  flushContent,
  historyBefore,
} from "./repository.js";
import type { Message } from "./schemas.js";
import { TerminalWriteError, writeWithinBudget } from "./terminal-write.js";

/**
 * A slot of generation capacity, held from admission to the end of the job and released
 * exactly once (on rollback, or in the job's `finally`). Only shutdown refuses one today; the
 * capacity limits fill in the counting behind the same call sites.
 */
export type Reservation = { release(): void };

const TIMEOUT_DETAIL = "The answer was not finished within the time limit.";
const CANCELLED_DETAIL = "The server shut down before the answer was finished.";

/**
 * Why a job was stopped from outside its generation. `deleted` / `fenced`: its row is gone or
 * belongs to a newer attempt, so nothing more is written. `shutdown`: the server is closing.
 */
export type AbortReason = "deleted" | "fenced" | "shutdown";
/** Every way a job is stopped early: an abort, or its deadline passing. */
type StopReason = AbortReason | "deadline";

/** The reason a job's controller is aborted with; its signal's `reason`. */
class JobStopped extends Error {
  constructor(readonly stop: StopReason) {
    super(`the generation was stopped (${stop})`);
    this.name = "JobStopped";
  }
}

function stopReasonOf(signal: AbortSignal): StopReason | undefined {
  return signal.aborted && signal.reason instanceof JobStopped ? signal.reason.stop : undefined;
}

/**
 * What to log about a failure that may come from the database: its SQLSTATE when it has one
 * and nothing else, because both drizzle's message (the query's parameters) and the
 * database's own message can quote the answer's text. Without a SQLSTATE (a lost connection,
 * the budget running out), the innermost error's name and message, which are the driver's or
 * ours.
 */
function describeFailure(
  error: unknown,
): { code: string } | { name: string | undefined; reason: string | undefined } {
  const code = pgErrorCode(error);
  if (code !== undefined) {
    return { code };
  }
  const seen = new Set<unknown>();
  let current = error;
  let innermost: Error | undefined;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    innermost = current;
    current = current.cause;
  }
  return { name: innermost?.name, reason: innermost?.message };
}

/**
 * The provider's events until `signal` aborts. Providers must honour the signal (see the
 * port), but one that does not cannot hold a job past its deadline or a shutdown: every event
 * is raced against the abort, which then ends the iteration with the abort reason, and the
 * provider's stream is asked to end without being waited for.
 */
async function* untilAborted<T>(events: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = events[Symbol.asyncIterator]();
  let exhausted = false;
  try {
    for (;;) {
      // Checked first: once aborted, the provider is not resumed again.
      signal.throwIfAborted();
      const result = await untilAbort(iterator.next(), signal);
      if (result.done === true) {
        exhausted = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!exhausted) {
      // Not awaited: a provider that ignores the signal may never settle it.
      Promise.resolve(iterator.return?.()).catch(() => {});
    }
  }
}

/** Everything a job needs, frozen at admission. */
export type JobSpec = {
  assistantId: string;
  attempt: number;
  sessionId: string;
  userMessage: { seq: number; content: string };
  provider: LlmProvider;
  model: string;
  maxOutputTokens: number;
  systemPrompt: string | null;
  /** Decided at admission; never stored or logged, and cleared when the job ends. */
  apiKey: ApiKey;
  /** The clock's reading taken just before the admitting insert: the deadline's origin. */
  startedAtMonotonic: number;
  reservation: Reservation;
};

/**
 * How a job ended. `terminal`: its row holds this attempt's final state (written by the job,
 * or already there, e.g. after stale reclaim). `aborted`: it wrote no terminal state, because
 * its row was deleted or superseded. `write_failed`: storing the terminal state did not succeed within
 * the terminal-write budget, so the row is left generating for stale reclaim.
 */
export type JobEnd = "terminal" | "aborted" | "write_failed";

export type Job = Readonly<{
  assistantId: string;
  attempt: number;
  bus: MessageBus;
  /** Settles once the job has left the registry and closed its bus; never rejects. */
  finished: Promise<JobEnd>;
}>;

export interface JobRegistry {
  /** A capacity slot for a new generation; undefined once shutdown has begun. */
  reserve(): Reservation | undefined;
  /** Starts generating in the background. Call only after the admitting transaction commits. */
  start(spec: JobSpec): Job;
  /** The job running for this assistant message in this process, if any. */
  get(assistantId: string): Job | undefined;
  /**
   * Refuses new reservations, aborts every job (also those started meanwhile) and waits, at
   * most `waitMs` in all, for each to finish.
   */
  shutdown(waitMs: number): Promise<void>;
}

type RunningJob = Job & { controller: AbortController };

/** The settings a job registry runs with; an AppConfig has them all. */
export type JobTiming = Pick<
  AppConfig,
  | "flushIntervalMs"
  | "generationDeadlineMs"
  | "terminalStatementTimeoutMs"
  | "terminalWriteBudgetMs"
>;

export function createJobRegistry(deps: {
  db: Db;
  timing: JobTiming;
  clock: Clock;
  log: FastifyBaseLogger;
}): JobRegistry {
  const { db, timing, clock, log } = deps;
  const jobs = new Map<string, RunningJob>();
  /** Set by shutdown(): jobs started afterwards are aborted immediately. */
  let closing = false;
  /**
   * Reservations taken and not yet released: admissions in progress and running jobs. Shutdown
   * waits for both, so a send that was committing when it began is cancelled and waited for.
   */
  let outstanding = 0;
  /** Wakes whoever waits for the next release or job end (shutdown). */
  let wake: Array<() => void> = [];
  const changed = (): void => {
    const waiting = wake;
    wake = [];
    for (const resolve of waiting) {
      resolve();
    }
  };

  /** Resolves with the terminal message it wrote, or undefined when it wrote none. */
  async function run(spec: JobSpec, job: RunningJob): Promise<Message | undefined> {
    const fence = { id: spec.assistantId, attempt: spec.attempt };
    const jobLog = log.child({ assistantId: spec.assistantId, attempt: spec.attempt });
    /**
     * This attempt's final state when it is already stored: by an earlier try whose commit
     * reached the database although the job saw it fail, or by stale reclaim. Undefined when
     * the row is gone, belongs to a newer attempt, or is still generating.
     */
    const ownFinalState = async (tx: Tx): Promise<Message | undefined> => {
      const row = await findMessage(tx, spec.sessionId, spec.assistantId);
      return row?.attempt === spec.attempt && row.status !== "generating" ? row : undefined;
    };
    /**
     * Every terminal write goes through the budget; it throws TerminalWriteError. When the
     * fence no longer matches, the row's own final state (if this attempt has one) is reported;
     * it is read in the same try, so the read is bounded and retried like the write, and a row
     * whose state cannot be read ends as a failed write rather than as "deleted".
     */
    const store = (write: (tx: Tx) => Promise<Message | undefined>): Promise<Message | undefined> =>
      writeWithinBudget(
        {
          db,
          clock,
          limits: {
            statementTimeoutMs: timing.terminalStatementTimeoutMs,
            budgetMs: timing.terminalWriteBudgetMs,
          },
        },
        async (tx) => (await write(tx)) ?? (await ownFinalState(tx)),
      );
    const { controller, bus } = job;
    let fenceLost = false;
    let flushed = "";
    let flushing: Promise<void> | undefined;

    const loseFence = (): void => {
      fenceLost = true;
      controller.abort(new JobStopped("fenced"));
    };

    const flush = (): void => {
      const content = bus.snapshot();
      if (flushing !== undefined || fenceLost || content === flushed) {
        return;
      }
      // Limited in the database too, so a flush the job stops waiting for frees its connection.
      flushing = db
        .tx(async (tx) => {
          await limitStatements(tx, timing.terminalStatementTimeoutMs);
          return flushContent(tx, fence, content);
        })
        .then((matched) => {
          if (matched) {
            flushed = content;
          } else {
            jobLog.info("fenced flush matched no row; stopping this generation");
            loseFence();
          }
        })
        .catch((error: unknown) => {
          // By SQLSTATE only: the failed query's parameters hold the partial answer.
          jobLog.warn(
            describeFailure(error),
            "flushing partial content failed; retrying on next tick",
          );
        })
        .finally(() => {
          flushing = undefined;
        });
    };
    // Counted from before the admitting insert, so the job always stops before stale reclaim
    // could consider its row dead (both measure from earlier than started_at).
    const leftMs = remainingMs(
      timing.generationDeadlineMs,
      spec.startedAtMonotonic,
      clock.monotonicNow(),
    );
    if (leftMs === 0) {
      jobLog.warn("no time left before the deadline; the provider is not called");
      return store((tx) =>
        failAssistant(tx, fence, {
          content: "",
          errorCode: "llm_timeout",
          errorDetail: TIMEOUT_DETAIL,
        }),
      );
    }
    // One timer per job, cleared below; AbortSignal.timeout() could not be cleared (V1).
    const deadline = setTimeout(() => controller.abort(new JobStopped("deadline")), leftMs);
    const timer = setInterval(flush, timing.flushIntervalMs);

    // Generation: any error here is the provider's (or reading the history); never a terminal
    // write, which happens below so that its failure is not mistaken for an upstream error.
    let finish: { reason: LlmFinishReason; usage: LlmUsage | null } | undefined;
    let generationFailed = false;
    let generationError: unknown;
    // Until the history is read, an error is the database's, not the provider's.
    let readingHistory = true;
    try {
      // A read stuck behind a lock must not hold the job: it stops waiting at the abort, and
      // the database cancels the read itself after one statement timeout at most (or at the
      // deadline, if sooner), so a read abandoned at a shutdown frees its connection in time.
      // Already stopped (e.g. admitted while the server closes): do not take a connection.
      controller.signal.throwIfAborted();
      const history = await untilAbort(
        db.tx(async (tx) => {
          const readMs = Math.min(
            timing.terminalStatementTimeoutMs,
            remainingMs(timing.generationDeadlineMs, spec.startedAtMonotonic, clock.monotonicNow()),
          );
          // At least 1 ms (0 would mean no limit): past the deadline the read fails at once.
          await limitStatements(tx, Math.max(1, readMs));
          return historyBefore(tx, spec.sessionId, spec.userMessage.seq);
        }),
        controller.signal,
      );
      readingHistory = false;
      const request = {
        model: spec.model,
        maxOutputTokens: spec.maxOutputTokens,
        messages: assembleContext({
          systemPrompt: spec.systemPrompt,
          history,
          userMessage: spec.userMessage,
          // Trimming is wired to the admitted model next.
          historyBudget: Number.POSITIVE_INFINITY,
        }),
      };
      // Stopped already (e.g. admitted while the server closes): do not call the provider.
      controller.signal.throwIfAborted();
      const events = spec.provider.stream(request, {
        signal: controller.signal,
        apiKey: spec.apiKey.reveal(),
      });
      for await (const event of untilAborted(events, controller.signal)) {
        if (event.type === "finish") {
          // The answer is complete, even if an abort came with it: do not wait for the
          // provider to close its stream, during which a deadline or shutdown would turn a
          // finished answer into a failure.
          finish = { reason: event.reason, usage: event.usage };
          break;
        }
        if (controller.signal.aborted) {
          break;
        }
        // PostgreSQL text cannot hold U+0000; one such character would make every write fail.
        bus.append(event.text.replaceAll("\u0000", ""));
      }
    } catch (error) {
      generationFailed = true;
      generationError = error;
    } finally {
      clearTimeout(deadline);
      clearInterval(timer);
      // A stalled database must not hold the job here past its deadline and budget. A flush
      // still running afterwards is fenced on `generating`, so it can never overwrite the
      // terminal state, which carries the full text anyway.
      if (flushing !== undefined) {
        await withTimeout(flushing, timing.terminalStatementTimeoutMs);
      }
    }

    // A complete answer is stored below even if the job was stopped meanwhile (unless its
    // fence was lost): the work is done, and storing it is the honest outcome.
    const answered = finish !== undefined && !generationFailed;
    const stopped = stopReasonOf(controller.signal);
    if (fenceLost || stopped === "fenced" || stopped === "deleted") {
      // The row is gone or belongs to a newer attempt: nothing more may be written.
      jobLog.info({ stopped }, "generation stopped without a terminal write");
      return undefined;
    }
    // A stop reason wins over the provider's own error: once aborted, the provider's error is
    // usually the abort itself, and the deadline or shutdown is what the client should see.
    if (!answered && (stopped === "deadline" || stopped === "shutdown")) {
      jobLog.warn({ stopped }, "generation stopped before the answer was finished");
      const timedOut = stopped === "deadline";
      return store((tx) =>
        failAssistant(tx, fence, {
          content: bus.snapshot(),
          errorCode: timedOut ? "llm_timeout" : "cancelled",
          errorDetail: timedOut ? TIMEOUT_DETAIL : CANCELLED_DETAIL,
        }),
      );
    }
    if (generationFailed && readingHistory) {
      // By SQLSTATE only: drizzle's error quotes the query and its parameters.
      jobLog.warn(describeFailure(generationError), "reading the history failed");
    } else if (generationFailed) {
      jobLog.warn({ err: generationError }, "generation failed");
    } else if (finish === undefined) {
      jobLog.warn("the provider ended the stream without a finish event");
    }

    // A terminal write that fails within its budget propagates: the caller logs it and the row
    // stays generating until stale reclaim fails it.
    const content = bus.snapshot();
    const latencyMs = Math.max(0, Math.round(clock.monotonicNow() - spec.startedAtMonotonic));
    const terminal =
      finish === undefined || generationFailed
        ? await store((tx) =>
            failAssistant(tx, fence, {
              content,
              ...failureOf(generationError),
            }),
          )
        : await store((tx) =>
            completeAssistant(tx, fence, {
              content,
              usage: finish.usage,
              finishReason: finish.reason,
              latencyMs,
            }),
          );
    if (terminal === undefined) {
      jobLog.info("terminal write matched no row; the turn was deleted or superseded");
    }
    return terminal;
  }

  return {
    reserve() {
      if (closing) {
        return undefined;
      }
      // Only outstanding reservations are counted so far; the capacity limits add theirs.
      outstanding += 1;
      let released = false;
      return {
        release: () => {
          if (!released) {
            released = true;
            outstanding -= 1;
            changed();
          }
        },
      };
    },

    start(spec) {
      const controller = new AbortController();
      const bus = createBus((error) =>
        log.warn({ err: error, assistantId: spec.assistantId }, "a stream subscriber threw"),
      );
      let settle!: (end: JobEnd) => void;
      const finished = new Promise<JobEnd>((resolve) => {
        settle = resolve;
      });
      const job: RunningJob = {
        assistantId: spec.assistantId,
        attempt: spec.attempt,
        bus,
        finished,
        controller,
      };
      jobs.set(spec.assistantId, job);
      if (closing) {
        // Admitted while the server shuts down: end at once instead of holding the close open.
        controller.abort(new JobStopped("shutdown"));
      }

      let terminal: Message | undefined;
      let end: JobEnd = "aborted";
      void run(spec, job)
        .then(
          (message) => {
            terminal = message;
            end = message === undefined ? "aborted" : "terminal";
          },
          (error: unknown) => {
            const ids = { assistantId: spec.assistantId, attempt: spec.attempt };
            if (error instanceof TerminalWriteError) {
              log.error(
                { ...ids, writeAttempts: error.attempts, ...describeFailure(error.cause) },
                "the terminal write did not succeed within its budget; stale reclaim will fail the turn",
              );
            } else {
              log.error(
                { ...ids, ...describeFailure(error) },
                "the generation job failed unexpectedly",
              );
            }
            end = "write_failed";
          },
        )
        .finally(() => {
          // Each step runs even if another throws, and "finished" settles whatever happens,
          // or waiters and shutdown would hang.
          const cleanup = (step: string, fn: () => void): void => {
            try {
              fn();
            } catch (error) {
              log.error({ err: error, assistantId: spec.assistantId, step }, "job cleanup failed");
            }
          };
          cleanup("key", () => spec.apiKey.clear());
          cleanup("release", () => spec.reservation.release());
          cleanup("leave", () => {
            if (jobs.get(spec.assistantId) === job) {
              jobs.delete(spec.assistantId);
            }
          });
          cleanup("close", () => bus.close(terminal));
          settle(end);
          changed();
        })
        // Only a throwing logger could get here; nothing is left to clean up.
        .catch(() => {});
      return job;
    },

    get: (assistantId) => jobs.get(assistantId),

    async shutdown(waitMs) {
      closing = true;
      const started = clock.monotonicNow();
      for (;;) {
        // Also jobs started meanwhile: an admission that was committing when shutdown began.
        for (const job of jobs.values()) {
          job.controller.abort(new JobStopped("shutdown"));
        }
        const leftMs = remainingMs(waitMs, started, clock.monotonicNow());
        if ((jobs.size === 0 && outstanding === 0) || leftMs === 0) {
          return;
        }
        const waiting = new AbortController();
        await Promise.race([
          new Promise<void>((resolve) => wake.push(resolve)),
          sleep(leftMs, undefined, { signal: waiting.signal, ref: false }).catch(() => {}),
        ]);
        waiting.abort();
      }
    },
  };
}
