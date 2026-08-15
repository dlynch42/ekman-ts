import { describe, expect, it } from "vitest";
import { isEkmanError } from "../src/errors";
import type { MemoryConfig } from "../src/memory";
import { accountBytes, MemoryLedger, resolveMemoryConfig } from "../src/memory";

const code = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isEkmanError(error) ? error.code : "not-an-ekman-error";
  }
  return "no-throw";
};

const resolve = (config: MemoryConfig | undefined, hasStore = true) =>
  resolveMemoryConfig(config, { hasStore });

describe("accounting", () => {
  it("measures the key, the state and the serialized values", () => {
    // The documented basis, stated as arithmetic so a port can check itself against it.
    expect(accountBytes("orders:1", "open", {}, undefined)).toBe(
      "orders:1".length + "open".length + "{}".length
    );
  });

  it("counts UTF-8 bytes rather than characters", () => {
    // A naive length would report the same number for both, and a budget that cannot tell
    // them apart is not measuring bytes.
    const ascii = accountBytes("orders:1", "open", { v: "aaa" }, undefined);
    const wide = accountBytes("orders:1", "open", { v: "日本語" }, undefined);
    expect(wide).toBeGreaterThan(ascii);
  });

  it("grows with the values it is given", () => {
    const small = accountBytes("orders:1", "open", { a: 1 }, undefined);
    const large = accountBytes(
      "orders:1",
      "open",
      { a: 1, b: "a longer string than before" },
      undefined
    );
    expect(large).toBeGreaterThan(small);
  });

  it("uses a supplied size function in place of serializing", () => {
    expect(accountBytes("orders:1", "open", { a: 1 }, () => 500)).toBe(
      "orders:1".length + "open".length + 500
    );
  });
});

describe("resolving the memory configuration", () => {
  it("is unlimited when nothing is configured", () => {
    const resolved = resolve(undefined);
    expect(resolved.maxBytes).toBe(Number.POSITIVE_INFINITY);
    expect(resolved.bounded).toBe(false);
    expect(resolved.policy).toBe("lru");
  });

  it.each([-1, 1.5, "lots"])("refuses a maxBytes of %s", (maxBytes) => {
    expect(code(() => resolve({ maxBytes: maxBytes as number }))).toBe(
      "INVALID_CONFIG"
    );
  });

  it("refuses an eviction policy it does not recognize", () => {
    expect(code(() => resolve({ eviction: { policy: "yolo" as "lru" } }))).toBe(
      "INVALID_CONFIG"
    );
  });

  it("defaults snapshotOnEvict to on when a store is configured", () => {
    expect(resolve({ maxBytes: 100 }).snapshotOnEvict).toBe(true);
  });

  it("defaults it to off with no store, and refuses it if asked for", () => {
    // Silently ignoring the setting would be the worst option: it reads as configured and
    // does nothing.
    expect(
      resolve({ eviction: { allowDiscard: true } }, false).snapshotOnEvict
    ).toBe(false);
    expect(
      code(() => resolve({ eviction: { snapshotOnEvict: true } }, false))
    ).toBe("INVALID_CONFIG");
  });

  it("lets a runtime turn snapshotting off for write volume", () => {
    expect(
      resolve({ maxBytes: 100, eviction: { snapshotOnEvict: false } })
        .snapshotOnEvict
    ).toBe(false);
  });

  it("refuses a bounded lru budget that would discard state with nowhere to put it", () => {
    expect(code(() => resolve({ maxBytes: 100 }, false))).toBe(
      "INVALID_CONFIG"
    );
  });

  it("allows that discard when it is asked for explicitly", () => {
    expect(
      resolve({ maxBytes: 100, eviction: { allowDiscard: true } }, false)
        .allowDiscard
    ).toBe(true);
  });

  it("allows a bounded budget with no store under reject, which discards nothing", () => {
    expect(
      resolve({ maxBytes: 100, eviction: { policy: "reject" } }, false).policy
    ).toBe("reject");
  });

  it("allows an unlimited budget with no store, because nothing can be evicted", () => {
    expect(resolve(undefined, false).bounded).toBe(false);
  });

  it("refuses a zero budget with nowhere to load from", () => {
    // maxBytes 0 means every trigger loads through a store. Without one there is nothing
    // to load, so the setting cannot mean what it says.
    expect(code(() => resolve({ maxBytes: 0 }, false))).toBe("INVALID_CONFIG");
    expect(resolve({ maxBytes: 0 }, true).maxBytes).toBe(0);
  });
});

describe("MemoryLedger", () => {
  it("starts empty", () => {
    const ledger = new MemoryLedger();
    expect(ledger.total).toBe(0);
    expect(ledger.size).toBe(0);
    expect(ledger.lru).toEqual([]);
    expect(ledger.has("orders:1")).toBe(false);
    expect(ledger.bytesFor("orders:1")).toBe(0);
  });

  it("tracks a running total rather than summing on demand", () => {
    const ledger = new MemoryLedger();
    ledger.record("orders:1", 10);
    ledger.record("orders:2", 25);

    expect(ledger.total).toBe(35);
    expect(ledger.size).toBe(2);
    expect(ledger.bytesFor("orders:2")).toBe(25);
  });

  it("adjusts the total when a key is re-measured", () => {
    const ledger = new MemoryLedger();
    ledger.record("orders:1", 10);
    ledger.record("orders:1", 40);

    expect(ledger.total).toBe(40);
    expect(ledger.size).toBe(1);
  });

  it("orders keys least recently used first", () => {
    const ledger = new MemoryLedger();
    ledger.record("orders:1", 1);
    ledger.record("orders:2", 1);
    ledger.record("orders:3", 1);

    expect(ledger.lru).toEqual(["orders:1", "orders:2", "orders:3"]);

    // Re-measuring counts as use, which is what makes commit order drive eviction order.
    ledger.record("orders:1", 2);
    expect(ledger.lru).toEqual(["orders:2", "orders:3", "orders:1"]);
  });

  it("moves a key to the back on a touch without changing what it costs", () => {
    const ledger = new MemoryLedger();
    ledger.record("orders:1", 10);
    ledger.record("orders:2", 10);

    ledger.touch("orders:1");
    expect(ledger.lru).toEqual(["orders:2", "orders:1"]);
    expect(ledger.total).toBe(20);
  });

  it("ignores a touch for a key it does not hold", () => {
    const ledger = new MemoryLedger();
    ledger.record("orders:1", 10);
    ledger.touch("orders:404");
    expect(ledger.lru).toEqual(["orders:1"]);
  });

  it("returns what a released key was costing", () => {
    const ledger = new MemoryLedger();
    ledger.record("orders:1", 10);
    ledger.record("orders:2", 25);

    expect(ledger.release("orders:1")).toBe(10);
    expect(ledger.total).toBe(25);
    expect(ledger.release("orders:404")).toBe(0);
    expect(ledger.total).toBe(25);
  });
});
