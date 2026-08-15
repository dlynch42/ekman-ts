import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Ekman } from "../src/ekman";
import { defineEntity } from "../src/entity";
import type { EkmanError } from "../src/errors";
import type { EkmanEvent } from "../src/events";
import { stay, transitionTo } from "../src/results";
import type { Store } from "../src/store";
import { EMPTY_SEQ, entityOf, latestSeq, replay, scanKeys } from "../src/store";
import { fileStore } from "../src/stores/file";
import { MemoryStore, memoryStore } from "../src/stores/memory";
import type { TelemetryEvent } from "../src/telemetry";

const orders = defineEntity("orders", {
  initial: "open",
  states: {
    open: (_i, trigger) =>
      trigger.type === "close" ? transitionTo("closed") : stay({ n: 1 }),
    closed: () => stay(),
  },
});

/** A store that wraps another and can be told to misbehave in one specific way. */
function wrap(
  inner: Store,
  overrides: Partial<Pick<Store, "append" | "load" | "snapshot">>
): Store {
  return {
    name: inner.name,
    capabilities: inner.capabilities,
    append: overrides.append ?? inner.append.bind(inner),
    load: overrides.load ?? inner.load.bind(inner),
    read: inner.read.bind(inner),
    snapshot: overrides.snapshot ?? inner.snapshot.bind(inner),
    scan: inner.scan.bind(inner),
  };
}

describe("committing through a store", () => {
  it("persists before it applies, so a failed write changes nothing", async () => {
    const inner = memoryStore();
    const store = wrap(inner, {
      append: (key, event, expectedSeq) =>
        event.type === "transition" && event.seq === 1
          ? Promise.reject(new Error("disk is on fire"))
          : inner.append(key, event, expectedSeq),
    });

    const ekman = new Ekman({ entities: [orders], store });

    await expect(
      ekman.entities.orders.send("1", { type: "close" })
    ).rejects.toThrow();

    // Nothing applied: the instance is exactly where the durable record says it is.
    expect(ekman.entities.orders.inspect("1")).toMatchObject({
      state: "open",
      seq: 0,
    });
    await ekman.close();
  });

  it("refuses to start when a key's sequence has moved under it", async () => {
    const store = memoryStore();
    const ekman = new Ekman({ entities: [orders], store });

    await ekman.entities.orders.send("1", { type: "touch" });

    // Something else wrote to the key. The next conditional append cannot hold.
    await store.append(
      "orders:1",
      {
        type: "transition",
        key: "orders:1",
        from: "open",
        to: "open",
        seq: 2,
        at: 0,
        cause: { type: "elsewhere", id: "x" },
        values: {},
      },
      1
    );

    const failure = await ekman.entities.orders
      .send("1", { type: "touch" })
      .catch((error: EkmanError) => error.code);

    expect(failure).toBe("STORE_CONFLICT");
    await ekman.close();
  });

  it("keeps a commit that reached the store even when a timeout crossed it", async () => {
    // The narrow window the seal exists for. Refusing the result here would leave the
    // store holding an event the runtime never applied, and replay would then reconstruct
    // a state the live runtime never had.
    const inner = memoryStore();
    const slow = wrap(inner, {
      append: async (key, event, expectedSeq) => {
        if (event.type === "transition" && event.seq === 1) {
          await new Promise((done) => setTimeout(done, 40));
        }
        return inner.append(key, event, expectedSeq);
      },
    });

    const seen: TelemetryEvent[] = [];
    const ekman = new Ekman({
      entities: [orders],
      store: slow,
      execution: { timeoutMs: 10 },
      telemetry: { "*": (event) => seen.push(event) },
    });

    // The sender is told it timed out.
    const outcome = await ekman.entities.orders
      .send("1", { type: "close" })
      .catch((error: EkmanError) => error.code);
    expect(outcome).toBe("HANDLER_TIMEOUT");

    // The write lands anyway, and the runtime says so rather than hiding it.
    await vi.waitFor(() =>
      expect(seen.map((e) => e.type)).toContain("commit.raced")
    );
    expect(seen.find((e) => e.type === "commit.raced")).toMatchObject({
      reason: "timeout",
      seq: 1,
    });
    expect(ekman.entities.orders.inspect("1")).toMatchObject({
      state: "closed",
      seq: 1,
    });

    await ekman.close();
  });
});

describe("layered stores", () => {
  it("mirrors commits into the cache layers behind the authority", async () => {
    const cache = memoryStore({ name: "cache" });
    const truth = memoryStore({ name: "truth", authority: true });
    const ekman = new Ekman({ entities: [orders], store: [cache, truth] });

    await ekman.entities.orders.send("1", { type: "close" });
    await vi.waitFor(async () =>
      expect((await cache.load("orders:1"))?.seq).toBe(1)
    );

    expect((await truth.load("orders:1"))?.seq).toBe(1);
    await ekman.close();
  });

  it("reports a cache write it could not make, and commits anyway", async () => {
    const inner = memoryStore({ name: "cache" });
    const cache = wrap(inner, {
      append: () => Promise.reject(new Error("cache is gone")),
    });
    const truth = memoryStore({ name: "truth", authority: true });

    const seen: TelemetryEvent[] = [];
    const ekman = new Ekman({
      entities: [orders],
      store: [cache, truth],
      telemetry: { "*": (event) => seen.push(event) },
    });

    // A stale cache is a performance problem. Treating it as a commit failure would make
    // it a correctness one.
    await expect(
      ekman.entities.orders.send("1", { type: "close" })
    ).resolves.toMatchObject({ state: "closed" });

    await vi.waitFor(() =>
      expect(seen.map((e) => e.type)).toContain("store.cacheFailed")
    );
    expect(seen.find((e) => e.type === "store.cacheFailed")).toMatchObject({
      store: "cache",
      error: "cache is gone",
    });

    await ekman.close();
  });

  it("closes every layer that can be closed", async () => {
    const closed: string[] = [];
    const closeable = {
      ...memoryStore({ name: "closeable" }),
      close: () => {
        closed.push("closeable");
        return Promise.resolve();
      },
    } as Store;

    const ekman = new Ekman({
      entities: [orders],
      // One layer with a close, one without: the optional method must stay optional.
      store: [closeable, memoryStore({ name: "plain" })],
    });

    await ekman.close();
    expect(closed).toEqual(["closeable"]);
  });
});

describe("reloading", () => {
  it("brings an evicted instance back without the caller noticing", async () => {
    const store = memoryStore();
    const ekman = new Ekman({
      entities: [orders],
      store,
      memory: { maxBytes: 0 },
    });

    await ekman.entities.orders.send("1", { type: "close" });
    // maxBytes 0 means nothing stays resident.
    expect(ekman.residentKeys).toEqual([]);

    const result = await ekman.entities.orders.send("1", { type: "poke" });
    expect(result).toMatchObject({ state: "closed", seq: 2 });
    await ekman.close();
  });

  it("records the reload in the key's stream", async () => {
    const store = memoryStore();
    const first = new Ekman({ entities: [orders], store });
    await first.entities.orders.send("1", { type: "close" });
    await first.close();

    const second = new Ekman({ entities: [orders], store });
    await second.entities.orders.send("1", { type: "poke" });

    const { events } = await second.entities.orders.history("1");

    // The whole stream, including what the first runtime wrote, with the restore woven in
    // at the point this runtime picked the key up.
    expect(events.map((event) => `${event.type}@${event.seq}`)).toEqual([
      "transition@0",
      "transition@1",
      "restored@1",
      "transition@2",
    ]);
    expect(events[2]).toMatchObject({ type: "restored", from: "replay" });
    await second.close();
  });

  it("treats a key the store has forgotten as a new instance", async () => {
    const inner = memoryStore();
    // Loads as if the key had never existed, which is what a compacted or pruned store
    // looks like from here.
    const forgetful = wrap(inner, { load: () => Promise.resolve(undefined) });
    const ekman = new Ekman({ entities: [orders], store: forgetful });

    const result = await ekman.entities.orders.send("1", { type: "poke" });
    expect(result.seq).toBe(1);
    expect((await ekman.entities.orders.history("1")).events[0]).toMatchObject({
      type: "transition",
      from: null,
      seq: 0,
    });
    await ekman.close();
  });

  it("hydrates once even when several triggers arrive together", async () => {
    const inner = memoryStore();
    let loads = 0;
    const counted = wrap(inner, {
      load: (key) => {
        loads += 1;
        return inner.load(key);
      },
    });

    const ekman = new Ekman({ entities: [orders], store: counted });
    await Promise.all([
      ekman.entities.orders.send("1", { type: "a" }),
      ekman.entities.orders.send("1", { type: "b" }),
      ekman.entities.orders.send("1", { type: "c" }),
    ]);

    expect(loads).toBe(1);
    await ekman.close();
  });
});

describe("eviction", () => {
  it("never touches an instance with work in flight", async () => {
    const slow = defineEntity("slow", {
      initial: "open",
      states: {
        open: async (_i, trigger) => {
          if (trigger.type === "slow") {
            await new Promise((done) => setTimeout(done, 200));
          }
          return stay({ padding: "x".repeat(200) });
        },
      },
    });

    const ekman = new Ekman({
      entities: [slow],
      store: memoryStore(),
      memory: { maxBytes: 50 },
    });

    // Left in flight on purpose, so this key is busy while the budget is blown.
    const busy = ekman.entities.slow.send("1", { type: "slow" });
    // Finishes immediately, goes idle, and triggers the eviction pass.
    await ekman.entities.slow.send("2", { type: "fast" });

    // `slow:1` is over budget and least recently used, and is skipped regardless: evicting
    // it would throw away a commit that is still running.
    expect(ekman.residentKeys).toContain("slow:1");

    await busy;
    await ekman.close();
  });

  it("snapshots on the way out so the next load does not replay everything", async () => {
    const store = new MemoryStore();
    const ekman = new Ekman({
      entities: [orders],
      store,
      memory: { maxBytes: 0 },
    });

    await ekman.entities.orders.send("1", { type: "close" });
    const loaded = await store.load("orders:1");

    expect(loaded?.snapshot).toMatchObject({ state: "closed", seq: 1 });
    await ekman.close();
  });

  it("does not snapshot when asked not to", async () => {
    const store = new MemoryStore();
    const ekman = new Ekman({
      entities: [orders],
      store,
      memory: { maxBytes: 0, eviction: { snapshotOnEvict: false } },
    });

    await ekman.entities.orders.send("1", { type: "close" });
    expect((await store.load("orders:1"))?.snapshot).toBeUndefined();
    await ekman.close();
  });

  it("reports what it released", async () => {
    const seen: TelemetryEvent[] = [];
    const ekman = new Ekman({
      entities: [orders],
      store: memoryStore(),
      memory: { maxBytes: 0 },
      telemetry: { "*": (event) => seen.push(event) },
    });

    await ekman.entities.orders.send("1", { type: "close" });

    expect(seen.find((e) => e.type === "instance.evicted")).toMatchObject({
      key: "orders:1",
      state: "closed",
      snapshotted: true,
      residentBytes: 0,
    });
    await ekman.close();
  });
});

describe("store helpers", () => {
  it("reads the entity out of a key, and copes with one that has no separator", () => {
    expect(entityOf("orders:1:2")).toBe("orders");
    expect(entityOf("orders")).toBe("orders");
  });

  it("reports the empty sequence for a stream with no commits", () => {
    expect(latestSeq([])).toBe(EMPTY_SEQ);
  });

  it("ignores non-commit events when replaying", () => {
    const events: EkmanEvent[] = [
      {
        type: "transition",
        key: "orders:1",
        from: null,
        to: "open",
        seq: 0,
        at: 10,
        cause: { type: "init", id: "t1" },
        values: {},
      },
      {
        type: "rejected",
        key: "orders:1",
        seq: 0,
        at: 20,
        cause: { type: "x", id: "t2" },
        code: "UNKNOWN_STATE",
        reason: "no",
      },
    ];

    expect(replay({ snapshot: undefined, events, seq: 0 })).toMatchObject({
      state: "open",
      seq: 0,
      enteredAt: 10,
    });
  });

  it("skips events a snapshot already folded in", () => {
    const snapshot = {
      key: "orders:1",
      entity: "orders",
      state: "closed",
      values: { n: 9 },
      seq: 5,
      enteredAt: 100,
      at: 100,
    };

    const stale: EkmanEvent = {
      type: "transition",
      key: "orders:1",
      from: "open",
      to: "open",
      seq: 3,
      at: 30,
      cause: { type: "old", id: "t1" },
      values: { n: 3 },
    };

    expect(replay({ snapshot, events: [stale], seq: 5 })).toMatchObject({
      state: "closed",
      seq: 5,
      values: { n: 9 },
    });
  });

  it("reports nothing for a stream that never committed anything", () => {
    const rejected: EkmanEvent = {
      type: "rejected",
      key: "orders:1",
      seq: -1,
      at: 0,
      cause: { type: "x", id: "t1" },
      code: "UNKNOWN_STATE",
      reason: "no",
    };

    expect(
      replay({ snapshot: undefined, events: [rejected], seq: EMPTY_SEQ })
    ).toBeUndefined();
  });

  it("skips a key whose stream cannot be replayed when scanning", async () => {
    const store = memoryStore();
    // A stream holding nothing but a refusal: the key exists, but no state was ever
    // committed for it, so it cannot match anything.
    await store.append(
      "orders:1",
      {
        type: "rejected",
        key: "orders:1",
        seq: -1,
        at: 0,
        cause: { type: "x", id: "t1" },
        code: "UNKNOWN_TRIGGER",
        reason: "no",
      },
      EMPTY_SEQ
    );

    expect((await store.scan({ entity: "orders", now: 0 })).matches).toEqual(
      []
    );
  });

  it("mirrors a non-commit event into a cache at the sequence it followed", async () => {
    // A violation or a rejection does not advance the sequence, so a cache append for one
    // is conditional on the current sequence rather than on the one before it.
    const cache = memoryStore({ name: "cache" });
    const truth = memoryStore({ name: "truth", authority: true });

    const strict = defineEntity("strict", {
      initial: "open",
      triggers: ["known"],
      states: { open: () => stay() },
    });

    const ekman = new Ekman({
      entities: [strict],
      store: [cache, truth],
      inbox: { recordOverflow: true },
    });

    await ekman.entities.strict
      .send("1", { type: "unrecognized" })
      .catch(() => undefined);

    await vi.waitFor(async () =>
      expect((await cache.read("strict:1")).map((e) => e.type)).toEqual([
        "transition",
        "rejected",
      ])
    );
    await ekman.close();
  });

  it("reads back the full stream from a memory store", async () => {
    const store = memoryStore();
    expect(await store.read("orders:never")).toEqual([]);
  });

  it("lets a file store claim authority", () => {
    const dir = mkdtempSync(join(tmpdir(), "ekman-auth-"));
    try {
      expect(fileStore(dir, { authority: true }).authority).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a key that vanished between listing and loading during a scan", async () => {
    // A scan lists keys and then loads each one. Nothing stops a key from being compacted
    // away in between, and a scan has to tolerate that rather than fail the whole query.
    const result = await scanKeys(
      ["orders:1", "orders:2"],
      { entity: "orders", now: 0 },
      () => Promise.resolve(undefined)
    );

    expect(result.matches).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it("names the empty sequence readably in a conflict", async () => {
    const store = memoryStore();
    const message = await store
      .append(
        "orders:1",
        {
          type: "transition",
          key: "orders:1",
          from: null,
          to: "open",
          seq: 0,
          at: 0,
          cause: { type: "init", id: "t1" },
          values: {},
        },
        4
      )
      .catch((error: Error) => error.message);

    expect(message).toContain("has no events");
  });
});
