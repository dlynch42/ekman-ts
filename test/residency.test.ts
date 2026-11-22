import { describe, expect, it } from "vitest";
import { defineEntity } from "../src/entity";
import type { EkmanError } from "../src/errors";
import { Residency } from "../src/residency";
import { stay } from "../src/results";
import { memoryStore } from "../src/stores/memory";
import type { TelemetryEvent } from "../src/telemetry";
import { testDeps } from "./deps";

const orders = defineEntity("orders", {
  initial: "pending",
  values: { note: "" },
  states: { pending: () => stay(), paid: () => stay() },
});

const CAUSE = { type: "init", id: "t1" };

/** A residency over real records, with whatever telemetry it reported. */
const build = (options: Parameters<typeof testDeps>[0] = {}) => {
  const seen: TelemetryEvent[] = [];
  const residency = new Residency(
    testDeps({ ...options, telemetry: { "*": (event) => seen.push(event) } })
  );
  return { residency, seen };
};

describe("Residency", () => {
  it("holds a materialized record in all three structures", () => {
    const { residency } = build();

    const record = residency.materialize("orders:1", orders, CAUSE);

    expect(residency.get("orders:1")).toBe(record);
    expect(residency.holds(record)).toBe(true);
    expect([...residency.keys()]).toEqual(["orders:1"]);
    expect(residency.keysIn("orders", "pending")).toEqual(["orders:1"]);
    expect(residency.statesIn("orders")).toEqual(["pending"]);
    expect(residency.usage).toEqual({
      bytes: record.bytes,
      instances: 1,
      maxBytes: null,
    });
  });

  it("hands back the record it already holds for a key", () => {
    const { residency } = build();

    const first = residency.materialize("orders:1", orders, CAUSE);

    expect(residency.materialize("orders:1", orders, CAUSE)).toBe(first);
    expect(residency.usage.instances).toBe(1);
  });

  it("refuses to materialize past a budget whose policy is to reject", () => {
    const { residency, seen } = build({
      memory: { maxBytes: 1, eviction: { policy: "reject" } },
    });
    residency.materialize("orders:1", orders, CAUSE);

    let refusal: EkmanError | undefined;
    try {
      residency.materialize("orders:2", orders, CAUSE);
    } catch (error) {
      refusal = error as EkmanError;
    }

    expect(refusal?.code).toBe("MEMORY_EXHAUSTED");
    expect(residency.get("orders:2")).toBeUndefined();
    expect(seen.at(-1)).toMatchObject({
      type: "memory.refused",
      key: "orders:2",
      maxBytes: 1,
    });
    // The one already here is untouched, and still answers for its key.
    expect(residency.materialize("orders:1", orders, CAUSE)).toBeDefined();
  });

  it("measures time in state for a key that is where it was asked about", () => {
    const { residency } = build({ now: () => 1000 });
    const record = residency.materialize("orders:1", orders, CAUSE);

    expect(residency.ageOf("orders:1", "pending", 1600)).toEqual({
      instance: record,
      elapsedMs: 600,
    });
    expect(residency.ageOf("orders:1", "paid", 1600)).toBeUndefined();
    expect(residency.ageOf("orders:2", "pending", 1600)).toBeUndefined();
  });

  it("re-indexes a record a commit moved, and only then", () => {
    const { residency } = build();
    const record = residency.materialize("orders:1", orders, CAUSE);
    const committed = {
      key: "orders:1",
      entity: "orders",
      state: "paid",
      bytes: record.bytes + 10,
    };

    residency.committed({ ...committed, state: "pending" }, false);
    expect(residency.keysIn("orders", "pending")).toEqual(["orders:1"]);
    expect(residency.bytes).toBe(record.bytes + 10);

    residency.committed(committed, true);
    expect(residency.keysIn("orders", "pending")).toEqual([]);
    expect(residency.keysIn("orders", "paid")).toEqual(["orders:1"]);
  });

  it("reports what an instance costs against the budget", () => {
    const { residency, seen } = build({
      memory: { maxBytes: 1, eviction: { policy: "none" } },
    });
    const record = residency.materialize("orders:1", orders, CAUSE);

    residency.account(record);

    expect(seen.at(-1)).toMatchObject({
      type: "memory.accounted",
      key: "orders:1",
      bytes: record.bytes,
      residentBytes: record.bytes,
      residentCount: 1,
      maxBytes: 1,
      overBudget: true,
    });
  });

  it("leaves no trace of a released record in any structure", () => {
    const { residency } = build();
    const record = residency.materialize("orders:1", orders, CAUSE);
    const { bytes } = record;

    expect(residency.release(record)).toBe(bytes);

    expect(residency.get("orders:1")).toBeUndefined();
    expect(residency.holds(record)).toBe(false);
    expect([...residency.keys()]).toEqual([]);
    expect([...residency.instances()]).toEqual([]);
    expect(residency.keysIn("orders", "pending")).toEqual([]);
    expect(residency.statesIn("orders")).toEqual([]);
    expect(residency.usage).toMatchObject({ bytes: 0, instances: 0 });
  });

  describe("over a budget that evicts", () => {
    const tight = {
      memory: { maxBytes: 1, eviction: { allowDiscard: true } },
    };

    it("evicts the idle records once one is offered, oldest first", () => {
      const { residency, seen } = build(tight);
      const first = residency.materialize("orders:1", orders, CAUSE);
      const second = residency.materialize("orders:2", orders, CAUSE);

      residency.offer(second);

      expect(residency.get("orders:1")).toBeUndefined();
      expect(residency.get("orders:2")).toBeUndefined();
      expect(residency.usage).toMatchObject({ bytes: 0, instances: 0 });
      expect(
        seen
          .filter((event) => event.type === "instance.evicted")
          .map((event) => event.key)
      ).toEqual([first.key, second.key]);
    });

    it("passes over a record that is not idle, however far over the budget is", () => {
      const { residency } = build(tight);
      const busy = residency.materialize("orders:1", orders, CAUSE);
      const idle = residency.materialize("orders:2", orders, CAUSE);
      const unpin = busy.pin();

      residency.offer(idle);

      expect(residency.get("orders:1")).toBe(busy);
      expect(residency.get("orders:2")).toBeUndefined();
      expect(residency.keysIn("orders", "pending")).toEqual(["orders:1"]);

      unpin();
      residency.offer(busy);
      expect(residency.get("orders:1")).toBeUndefined();
    });

    it("remembers an eviction snapshot until the store has it", async () => {
      const { residency, seen } = build({
        store: memoryStore({ name: "truth" }),
        memory: { maxBytes: 1 },
      });
      const record = residency.materialize("orders:1", orders, CAUSE);
      // Nothing is indexed for a record until what the store holds has been read.
      expect(residency.keysIn("orders", "pending")).toEqual([]);
      await record.ready();
      residency.loaded(record);
      expect(residency.keysIn("orders", "pending")).toEqual(["orders:1"]);

      residency.evict(record);

      expect(seen.at(-1)).toMatchObject({
        type: "instance.evicted",
        snapshotted: true,
      });

      const pending = residency.snapshotting("orders:1");
      expect(pending).toBeInstanceOf(Promise);
      await pending;
      expect(residency.snapshotting("orders:1")).toBeUndefined();
    });

    it("reports a snapshot the store would not take, and releases the record anyway", async () => {
      const store = memoryStore({ name: "truth" });
      store.snapshot = () => Promise.reject(new Error("disk is full"));
      const unhandled: unknown[] = [];
      const residency = new Residency(
        testDeps({
          store,
          memory: { maxBytes: 1 },
          onUnhandled: (error, context) => unhandled.push([error, context]),
        })
      );
      const record = residency.materialize("orders:1", orders, CAUSE);
      await record.ready();
      residency.loaded(record);

      residency.evict(record);
      await residency.snapshotting("orders:1");

      expect(residency.get("orders:1")).toBeUndefined();
      expect(unhandled).toEqual([
        [
          expect.objectContaining({ message: "disk is full" }),
          { source: "snapshot", key: "orders:1" },
        ],
      ]);
    });
  });
});
