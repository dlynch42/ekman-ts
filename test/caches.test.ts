import { describe, expect, it, vi } from "vitest";
import type { CacheFailure } from "../src/caches";
import { Caches } from "../src/caches";
import type { ReplayedState, Store } from "../src/store";
import { memoryStore } from "../src/stores/memory";

const STATE: ReplayedState = {
  state: "open",
  values: { n: 3 },
  seq: 3,
  enteredAt: 0,
};

/** A cache layer whose delete fails, so the first thing that goes wrong leaves it distrusted. */
function unclearable(): {
  layer: Store;
  snapshot: ReturnType<typeof vi.fn>;
  forget: ReturnType<typeof vi.fn>;
} {
  const inner = memoryStore({ name: "cache" });
  const snapshot = vi.fn(() => Promise.reject(new Error("no room")));
  const forget = vi.fn(() => Promise.reject(new Error("cannot delete")));
  const layer: Store = {
    name: inner.name,
    capabilities: inner.capabilities,
    append: inner.append.bind(inner),
    load: inner.load.bind(inner),
    read: inner.read.bind(inner),
    scan: inner.scan.bind(inner),
    snapshot,
    forget,
  };
  return { layer, snapshot, forget };
}

describe("a cache layer nobody can vouch for", () => {
  it("is not cleared again, and not filled again, for that key", async () => {
    const { layer, snapshot, forget } = unclearable();
    const failures: CacheFailure[] = [];
    const caches = new Caches([layer], {
      now: () => 0,
      failed: (failure) => failures.push(failure),
    });

    caches.refill("orders:1", STATE);
    await caches.settled("orders:1");
    expect(failures.map((failure) => failure.error)).toEqual([
      "no room",
      "cannot delete",
    ]);

    caches.drop("orders:1", 3);
    caches.refill("orders:1", STATE);
    await caches.settled("orders:1");

    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(forget).toHaveBeenCalledTimes(1);
    expect(failures).toHaveLength(2);
  });

  it("is still used for every other key", async () => {
    const { layer, snapshot } = unclearable();
    const caches = new Caches([layer], {
      now: () => 0,
      failed: () => undefined,
    });

    caches.refill("orders:1", STATE);
    await caches.settled("orders:1");
    caches.refill("orders:2", STATE);
    await caches.settled("orders:2");

    expect(snapshot).toHaveBeenCalledTimes(2);
  });
});

describe("a runtime with no cache layers", () => {
  it("has nothing queued for any key", async () => {
    const caches = new Caches([], { now: () => 0, failed: () => undefined });

    expect(caches.any).toBe(false);
    await expect(caches.settled("orders:1")).resolves.toBeUndefined();
  });
});
