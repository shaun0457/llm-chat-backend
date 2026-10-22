import { afterEach, describe, expect, it, vi } from "vitest";

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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("answers as soon as the job ends within the wait and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const { job, end } = controlledJob();
    let status: Message["status"] = "generating";
    const pending = attachWith(job, () => turn(status)).json(ASSISTANT, 1, 5_000);

    await vi.advanceTimersByTimeAsync(20);
    status = "completed";
    end("terminal");
    const outcome = await pending;

    expect(outcome?.kind).toBe("completed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up once the wait has passed and reports pending", async () => {
    vi.useFakeTimers();
    const { job } = controlledJob();
    let settled = false;
    const pending = attachWith(job, () => turn("generating"))
      .json(ASSISTANT, 1, 50)
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await pending;

    expect(outcome?.kind).toBe("pending");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not wait for a job of another attempt", async () => {
    vi.useFakeTimers();
    const { job } = controlledJob(2);

    // No timer is advanced: a wait would never end.
    const outcome = await attachWith(job, () => turn("generating")).json(ASSISTANT, 1, 5_000);

    expect(outcome?.kind).toBe("pending");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is pending when the job could not store the final state (stale reclaim fails it later)", async () => {
    const { job, end } = controlledJob();
    end("write_failed");

    const outcome = await attachWith(job, () => turn("generating")).json(ASSISTANT, 1, 5_000);

    expect(outcome?.kind).toBe("pending");
  });

  it("is undefined when the turn no longer exists", async () => {
    const attach = createAttach({
      jobs: { get: () => undefined },
      readTurn: async () => undefined,
    });

    expect(await attach.json(ASSISTANT, 1, 0)).toBeUndefined();
  });
});
