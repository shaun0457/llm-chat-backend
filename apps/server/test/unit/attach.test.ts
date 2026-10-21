import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

import { createAttach } from "../../src/modules/messages/attach.js";
import { createBus } from "../../src/modules/messages/bus.js";
import type { Job, JobEnd } from "../../src/modules/messages/jobs.js";
import type { Message, Turn } from "../../src/modules/messages/schemas.js";

const SESSION = "0190f5a0-0000-7000-8000-000000000001";
const USER = "0190f5a0-0000-7000-8000-000000000002";
const ASSISTANT = "0190f5a0-0000-7000-8000-000000000003";
const AT = "2026-10-22T10:00:00.000000Z";

function turn(status: Message["status"]): Turn {
  const common = {
    sessionId: SESSION,
    errorCode: null,
    errorDetail: null,
    usage: null,
    finishReason: null,
    latencyMs: null,
    createdAt: AT,
    updatedAt: AT,
  };
  return {
    userMessage: {
      ...common,
      id: USER,
      seq: 1,
      role: "user",
      content: "Hi",
      status: "completed",
      replyToId: null,
      attempt: null,
      provider: null,
      model: null,
    },
    assistantMessage: {
      ...common,
      id: ASSISTANT,
      seq: 2,
      role: "assistant",
      content: status === "generating" ? "Hel" : "Hello",
      status,
      replyToId: USER,
      attempt: 1,
      provider: "demo",
      model: "demo",
      ...(status === "failed"
        ? { errorCode: "llm_upstream_error", errorDetail: "The model provider returned an error." }
        : {}),
    },
  };
}

/** A job of attempt 1 whose end the test controls. */
function controlledJob(attempt = 1): { job: Job; end: (how: JobEnd) => void } {
  let end!: (how: JobEnd) => void;
  const finished = new Promise<JobEnd>((resolve) => {
    end = resolve;
  });
  return {
    job: { assistantId: ASSISTANT, attempt, bus: createBus(() => {}), finished },
    end,
  };
}

function attachWith(job: Job | undefined, read: () => Turn) {
  return createAttach({
    jobs: { get: (id) => (id === ASSISTANT ? job : undefined) },
    readTurn: async () => read(),
  });
}

describe("attach.json", () => {
  it.each(["completed", "failed"] as const)(
    "reports a turn already %s without waiting, even with no wait at all",
    async (status) => {
      const outcome = await attachWith(undefined, () => turn(status)).json(ASSISTANT, 1, 0);

      expect(outcome?.kind).toBe(status);
      expect(outcome?.assistantMessage.status).toBe(status);
    },
  );

  it("reports a terminal row as terminal even while a local job is still winding down", async () => {
    const { job } = controlledJob();

    const outcome = await attachWith(job, () => turn("completed")).json(ASSISTANT, 1, 0);

    expect(outcome?.kind).toBe("completed");
  });

  it("reports pending for a generating row when the wait is zero", async () => {
    const { job } = controlledJob();

    const outcome = await attachWith(job, () => turn("generating")).json(ASSISTANT, 1, 0);

    expect(outcome?.kind).toBe("pending");
    expect(outcome?.userMessage.id).toBe(USER);
  });

  it("answers as soon as the job ends within the wait", async () => {
    const { job, end } = controlledJob();
    let status: Message["status"] = "generating";
    setTimeout(() => {
      status = "completed";
      end("terminal");
    }, 20);

    const started = performance.now();
    const outcome = await attachWith(job, () => turn(status)).json(ASSISTANT, 1, 5_000);

    expect(outcome?.kind).toBe("completed");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("gives up after the wait and reports pending", async () => {
    const { job } = controlledJob();

    const started = performance.now();
    const outcome = await attachWith(job, () => turn("generating")).json(ASSISTANT, 1, 50);

    expect(outcome?.kind).toBe("pending");
    expect(performance.now() - started).toBeGreaterThanOrEqual(45);
  });

  it("does not wait for a job of another attempt", async () => {
    const { job } = controlledJob(2);

    const started = performance.now();
    const outcome = await attachWith(job, () => turn("generating")).json(ASSISTANT, 1, 5_000);

    expect(outcome?.kind).toBe("pending");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("fails when the job could not store the final state", async () => {
    const { job, end } = controlledJob();
    end("write_failed");

    await expect(
      attachWith(job, () => turn("generating")).json(ASSISTANT, 1, 5_000),
    ).rejects.toThrow("could not be stored");
  });

  it("is undefined when the turn no longer exists", async () => {
    const attach = createAttach({
      jobs: { get: () => undefined },
      readTurn: async () => undefined,
    });

    expect(await attach.json(ASSISTANT, 1, 0)).toBeUndefined();
  });
});
