import type { FastifyBaseLogger } from "fastify";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

import type { Db } from "../../db/client.js";
import type { LlmFinishReason, LlmProvider, LlmUsage } from "../../llm/port.js";
import { type MessageBus, createBus } from "./bus.js";
import { assembleContext } from "./context.js";
import { completeAssistant, failAssistant, flushContent, historyBefore } from "./repository.js";
import type { Message } from "./schemas.js";

/**
 * A slot of generation capacity, held from admission to the end of the job. A no-op until the
 * capacity limits exist; the call sites (reserve at admission, release on rollback and in the
 * job's `finally`) are already in place.
 */
export type Reservation = { release(): void };

export function reserveCapacity(): Reservation {
  let released = false;
  return {
    release() {
      if (released) {
        return;
      }
      released = true;
    },
  };
}

const UPSTREAM_ERROR_DETAIL = "The model provider returned an error.";
const shuttingDown = () => new Error("the server is shutting down");

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
  /** Stays null until per-request credentials exist; never stored or logged. */
  apiKey: string | null;
  /** performance.now() taken just before the admitting insert. */
  startedAtMonotonic: number;
  reservation: Reservation;
};

/**
 * How a job ended. `terminal`: it wrote completed or failed. `aborted`: it wrote no terminal
 * state on purpose (shutdown, or its row was deleted or superseded). `write_failed`: storing
 * the terminal state failed, so the row is left generating.
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
  /** Starts generating in the background. Call only after the admitting transaction commits. */
  start(spec: JobSpec): Job;
  /** The job running for this assistant message in this process, if any. */
  get(assistantId: string): Job | undefined;
  /** Aborts every job and waits (at most `waitMs`) for each to finish. */
  shutdown(waitMs: number): Promise<void>;
}

type RunningJob = Job & { controller: AbortController };

export function createJobRegistry(deps: {
  db: Db;
  flushIntervalMs: number;
  log: FastifyBaseLogger;
}): JobRegistry {
  const { db, flushIntervalMs, log } = deps;
  const jobs = new Map<string, RunningJob>();
  /** Set by shutdown(): jobs started afterwards are aborted immediately. */
  let closing = false;

  /** Resolves with the terminal message it wrote, or undefined when it wrote none. */
  async function run(spec: JobSpec, job: RunningJob): Promise<Message | undefined> {
    const fence = { id: spec.assistantId, attempt: spec.attempt };
    const jobLog = log.child({ assistantId: spec.assistantId, attempt: spec.attempt });
    const { controller, bus } = job;
    let fenceLost = false;
    let flushed = "";
    let flushing: Promise<void> | undefined;

    const loseFence = (): void => {
      fenceLost = true;
      controller.abort(new Error("the generating row was deleted or superseded"));
    };

    const flush = (): void => {
      const content = bus.snapshot();
      if (flushing !== undefined || fenceLost || content === flushed) {
        return;
      }
      flushing = flushContent(db.drizzle, fence, content)
        .then((matched) => {
          if (matched) {
            flushed = content;
          } else {
            jobLog.info("fenced flush matched no row; stopping this generation");
            loseFence();
          }
        })
        .catch((error: unknown) => {
          jobLog.warn({ err: error }, "flushing partial content failed; retrying on next tick");
        })
        .finally(() => {
          flushing = undefined;
        });
    };
    const timer = setInterval(flush, flushIntervalMs);

    // Generation: any error here is the provider's (or reading the history); never a terminal
    // write, which happens below so that its failure is not mistaken for an upstream error.
    let finish: { reason: LlmFinishReason; usage: LlmUsage | null } | undefined;
    let generationFailed = false;
    let generationError: unknown;
    try {
      const history = await historyBefore(db.drizzle, spec.sessionId, spec.userMessage.seq);
      const request = {
        model: spec.model,
        maxOutputTokens: spec.maxOutputTokens,
        messages: assembleContext({
          systemPrompt: spec.systemPrompt,
          history,
          userMessage: spec.userMessage,
        }),
      };
      for await (const event of spec.provider.stream(request, {
        signal: controller.signal,
        apiKey: spec.apiKey,
      })) {
        if (controller.signal.aborted) {
          break;
        }
        if (event.type === "delta") {
          // PostgreSQL text cannot hold U+0000; one such character would make every write fail.
          bus.append(event.text.replaceAll("\u0000", ""));
        } else {
          finish = { reason: event.reason, usage: event.usage };
        }
      }
    } catch (error) {
      generationFailed = true;
      generationError = error;
    } finally {
      clearInterval(timer);
      await flushing;
    }

    if (controller.signal.aborted) {
      // Fencing lost (nothing more may be written) or shutdown (the row stays generating until
      // stale reclaim exists).
      jobLog.info({ fenceLost }, "generation aborted");
      return undefined;
    }
    if (generationFailed) {
      jobLog.warn({ err: generationError }, "generation failed");
    } else if (finish === undefined) {
      jobLog.warn("the provider ended the stream without a finish event");
    }

    // A thrown terminal write propagates: the caller reports it and the row stays generating.
    const terminal =
      finish === undefined || generationFailed
        ? await failAssistant(db.drizzle, fence, {
            content: bus.snapshot(),
            errorCode: "llm_upstream_error",
            errorDetail: UPSTREAM_ERROR_DETAIL,
          })
        : await completeAssistant(db.drizzle, fence, {
            content: bus.snapshot(),
            usage: finish.usage,
            finishReason: finish.reason,
            latencyMs: Math.max(0, Math.round(performance.now() - spec.startedAtMonotonic)),
          });
    if (terminal === undefined) {
      jobLog.info("terminal write matched no row; the turn was deleted or superseded");
    }
    return terminal;
  }

  return {
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
        controller.abort(shuttingDown());
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
            // A terminal write failed: the row stays generating until stale reclaim exists.
            log.error({ err: error, assistantId: spec.assistantId }, "terminal write failed");
            end = "write_failed";
          },
        )
        .finally(() => {
          // "finished" must settle whatever happens here, or waiters and shutdown would hang.
          try {
            spec.reservation.release();
            if (jobs.get(spec.assistantId) === job) {
              jobs.delete(spec.assistantId);
            }
            bus.close(terminal);
          } catch (error) {
            log.error({ err: error, assistantId: spec.assistantId }, "job cleanup failed");
          } finally {
            settle(end);
          }
        });
      return job;
    },

    get: (assistantId) => jobs.get(assistantId),

    async shutdown(waitMs) {
      closing = true;
      const running = [...jobs.values()];
      for (const job of running) {
        job.controller.abort(shuttingDown());
      }
      const waiting = new AbortController();
      await Promise.race([
        Promise.all(running.map((job) => job.finished)),
        sleep(waitMs, undefined, { signal: waiting.signal, ref: false }).catch(() => {}),
      ]);
      waiting.abort();
    },
  };
}
