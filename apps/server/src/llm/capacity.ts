import type { AppConfig } from "../config.js";
import type { ModelCatalog } from "./catalog.js";

/**
 * One active generation's slot, for one provider. `release()` gives it back once. The job
 * registry wraps it in its own Reservation, which admission and the job hold.
 */
export type CapacitySlot = Readonly<{ provider: string; release: () => void }>;

/** Why no slot was granted, and the limit that was reached. */
export type CapacityRejection = Readonly<{
  rejected: "server_busy" | "provider_busy";
  limit: number;
}>;

/**
 * In-memory counters of active generations: one for the whole process and one per provider.
 * They are per process; a second process (e.g. during a deploy overlap) has its own.
 */
export interface Capacity {
  /**
   * Synchronous check-and-increment of both counters. The process limit is checked first, so
   * when both are full the answer is server_busy. Nothing is counted when it refuses.
   */
  tryReserve(provider: string): CapacitySlot | CapacityRejection;
}

export type CapacityLimits = Readonly<{
  /** Active generations in this process at most. */
  maxActive: number;
  /** Active generations per provider at most. */
  perProvider: (provider: string) => number;
}>;

export function createCapacity(limits: CapacityLimits): Capacity {
  let active = 0;
  const byProvider = new Map<string, number>();

  return {
    tryReserve(provider) {
      if (active >= limits.maxActive) {
        return { rejected: "server_busy", limit: limits.maxActive };
      }
      const providerLimit = limits.perProvider(provider);
      const providerActive = byProvider.get(provider) ?? 0;
      if (providerActive >= providerLimit) {
        return { rejected: "provider_busy", limit: providerLimit };
      }
      active += 1;
      byProvider.set(provider, providerActive + 1);
      let released = false;
      return {
        provider,
        release: () => {
          if (released) {
            return;
          }
          released = true;
          active -= 1;
          const left = (byProvider.get(provider) ?? 1) - 1;
          if (left === 0) {
            byProvider.delete(provider);
          } else {
            byProvider.set(provider, left);
          }
        },
      };
    },
  };
}

/**
 * The configured limits: MAX_ACTIVE_GENERATIONS in all, and per provider its catalog
 * maxConcurrency, else MAX_ACTIVE_PER_PROVIDER.
 */
export function capacityFor(
  config: Pick<AppConfig, "maxActiveGenerations" | "maxActivePerProvider">,
  catalog: ModelCatalog,
): Capacity {
  return createCapacity({
    maxActive: config.maxActiveGenerations,
    perProvider: (provider) =>
      catalog.provider(provider)?.maxConcurrency ?? config.maxActivePerProvider,
  });
}
