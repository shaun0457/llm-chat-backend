import { describe, expect, it } from "vitest";

import { type Capacity, type Reservation, createCapacity } from "../../src/llm/capacity.js";

function reserved(capacity: Capacity, provider: string): Reservation {
  const result = capacity.tryReserve(provider);
  if ("rejected" in result) {
    throw new Error(`expected a reservation, got ${result.rejected}`);
  }
  return result;
}

describe("createCapacity", () => {
  const limits = { maxActive: 3, perProvider: (id: string) => (id === "small" ? 1 : 2) };

  it("grants reservations up to the provider's limit, then refuses with provider_busy", () => {
    const capacity = createCapacity({ ...limits, maxActive: 10 });

    expect(reserved(capacity, "big").provider).toBe("big");
    reserved(capacity, "big");

    expect(capacity.tryReserve("big")).toEqual({ rejected: "provider_busy", limit: 2 });
    expect(reserved(capacity, "small").provider).toBe("small");
    expect(capacity.tryReserve("small")).toEqual({ rejected: "provider_busy", limit: 1 });
  });

  it("refuses with server_busy once the process total is reached, whatever the provider", () => {
    const capacity = createCapacity(limits);
    reserved(capacity, "big");
    reserved(capacity, "big");
    reserved(capacity, "small");

    expect(capacity.tryReserve("other")).toEqual({ rejected: "server_busy", limit: 3 });
    // Both full at once: the process limit decides.
    expect(capacity.tryReserve("small")).toEqual({ rejected: "server_busy", limit: 3 });
  });

  it("gives a slot back on release, exactly once however often release is called", () => {
    const capacity = createCapacity(limits);
    const first = reserved(capacity, "small");

    first.release();
    first.release();
    const second = reserved(capacity, "small");

    expect(capacity.tryReserve("small")).toEqual({ rejected: "provider_busy", limit: 1 });
    second.release();
    expect("rejected" in capacity.tryReserve("small")).toBe(false);
  });

  it("does not count a refused reservation", () => {
    const capacity = createCapacity({ maxActive: 1, perProvider: () => 1 });
    const held = reserved(capacity, "a");
    capacity.tryReserve("a");
    capacity.tryReserve("b");

    held.release();

    reserved(capacity, "b");
  });
});
