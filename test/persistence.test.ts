import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Ekman } from "../src/ekman";
import { defineEntity } from "../src/entity";
import { EkmanError } from "../src/errors";
import type { EkmanEvent } from "../src/events";
import { accountBytes } from "../src/memory";
import { fail, stay, transitionTo } from "../src/results";
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
  inner: MemoryStore,
  overrides: Partial<Pick<Store, "append" | "load" | "snapshot" | "forget">>
): Store {
  return {
    name: inner.name,
    capabilities: inner.capabilities,
    ...(inner.authority === undefined ? {} : { authority: inner.authority }),
    append: overrides.append ?? inner.append.bind(inner),
    load: overrides.load ?? inner.load.bind(inner),
    read: inner.read.bind(inner),
    snapshot: overrides.snapshot ?? inner.snapshot.bind(inner),
    scan: inner.scan.bind(inner),
    forget: overrides.forget ?? inner.forget.bind(inner),
  };
}

/** One turn of the event loop, which is long enough for an in-memory cache to catch up. */
const settle = (): Promise<void> =>
  new Promise((done) => {
    setImmediate(done);
  });

/** A commit made by something other than the runtime under test. */
const elsewhere = (seq: number): EkmanEvent => ({
  type: "transition",
  key: "orders:1",
  from: seq === 0 ? null : "open",
  to: "open",
  seq,
  at: 0,
  cause: { type: "elsewhere", id: `x${seq}` },
  values: { n: seq },
});

type CacheFailed = Extract<TelemetryEvent, { type: "store.cacheFailed" }>;

const cacheFailures = (seen: readonly TelemetryEvent[]): CacheFailed[] =>
  seen.filter(
    (event): event is CacheFailed => event.type === "store.cacheFailed"
  );

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

    const outcome = await ekman.entities.orders.send("1", { type: "close" });

    expect(outcome).toMatchObject({ state: "closed", seq: 1 });
    expect(seen.find((e) => e.type === "commit.raced")).toMatchObject({
      reason: "timeout",
      seq: 1,
    });
    expect(seen.map((e) => e.type)).not.toContain("handler.timedOut");
    expect(
      seen.filter((e) => e.type === "handler.settled").at(-1)
    ).toMatchObject({
      outcome: "committed",
    });

    const closed = await ekman.entities.orders.query({ state: "closed" });
    expect(closed.instances.map((match) => match.key)).toEqual(["orders:1"]);
    expect(ekman.memoryUsage.bytes).toBe(
      accountBytes("orders:1", "closed", {}, undefined)
    );

    await ekman.close();
  });
});

describe("loading an instance from the store", () => {
  const blip = () => new EkmanError("STORE_UNAVAILABLE", "blip");

  it("retries a first load that failed", async () => {
    const inner = memoryStore();
    let loads = 0;
    const store = wrap(inner, {
      load: (key) => {
        loads += 1;
        return loads === 1 ? Promise.reject(blip()) : inner.load(key);
      },
    });
    const ekman = new Ekman({ entities: [orders], store });

    const first = ekman.entities.orders
      .send("1", { type: "close" })
      .catch((error: EkmanError) => error.code);
    const queued = ekman.entities.orders.send("1", { type: "close" });

    expect(await first).toBe("STORE_UNAVAILABLE");
    const second = await queued;
    expect(loads).toBe(2);
    expect(second).toMatchObject({ state: "closed", seq: 1 });
    expect(ekman.entities.orders.inspect("1")).toMatchObject({
      state: "closed",
      seq: 1,
    });

    const { instances } = await ekman.entities.orders.query({});
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ key: "orders:1", resident: true });
    await ekman.close();
  });

  it("retries a first write that failed", async () => {
    const inner = memoryStore();
    let appends = 0;
    const store = wrap(inner, {
      append: (key, event, expectedSeq) => {
        appends += 1;
        return appends === 1
          ? Promise.reject(blip())
          : inner.append(key, event, expectedSeq);
      },
    });
    const ekman = new Ekman({ entities: [orders], store });

    const first = await ekman.entities.orders
      .send("1", { type: "close" })
      .catch((error: EkmanError) => error.code);
    expect(first).toBe("STORE_UNAVAILABLE");

    const second = await ekman.entities.orders.send("1", { type: "close" });
    expect(second).toMatchObject({ state: "closed", seq: 1 });
    await ekman.close();
  });

  it("does not keep an instance that never loaded", async () => {
    const inner = memoryStore();
    const store = wrap(inner, { load: () => Promise.reject(blip()) });
    const ekman = new Ekman({ entities: [orders], store });

    await ekman.entities.orders.send("1", { type: "close" }).catch(() => 0);

    expect(ekman.residentKeys).toEqual([]);
    expect(ekman.memoryUsage).toMatchObject({ instances: 0, bytes: 0 });
    expect(ekman.entities.orders.inspect("1")).toBeUndefined();
    await ekman.close();
  });

  it("does not report an instance that is still loading", async () => {
    const inner = memoryStore();
    const before = new Ekman({ entities: [orders], store: inner });
    await before.entities.orders.send("1", { type: "close" });
    await before.close();

    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const store = wrap(inner, {
      load: async (key) => {
        await gate;
        return inner.load(key);
      },
    });
    const ekman = new Ekman({ entities: [orders], store });
    const sent = ekman.entities.orders.send("1", { type: "poke" });

    expect(ekman.entities.orders.inspect("1")).toBeUndefined();
    const during = await ekman.entities.orders.query({ state: "open" });
    expect(during.instances).toEqual([]);

    open();
    await sent;

    expect(ekman.entities.orders.inspect("1")).toMatchObject({
      state: "closed",
      seq: 2,
    });
    const after = await ekman.entities.orders.query({ state: "closed" });
    expect(after.instances.map((match) => match.key)).toEqual(["orders:1"]);
    await ekman.close();
  });

  it("accounts restored values, not the initial ones", async () => {
    const notes = defineEntity("notes", {
      initial: "open",
      states: {
        open: (_i, trigger) =>
          trigger.type === "write"
            ? stay({ text: trigger.text as string })
            : fail(new Error("refused")),
      },
    });
    const text = "x".repeat(500);
    const shared = memoryStore();
    const writer = new Ekman({ entities: [notes], store: shared });
    await writer.entities.notes.send("1", { type: "write", text });
    await writer.close();

    const reader = new Ekman({ entities: [notes], store: shared });
    await reader.entities.notes.send("1", { type: "bad" }).catch(() => 0);

    expect(reader.memoryUsage.bytes).toBe(
      accountBytes("notes:1", "open", { text }, undefined)
    );
    await reader.close();
  });

  it("stamps a key that vanished with when it was initialized again", async () => {
    let now = 1000;
    const shared = memoryStore();
    const a = new Ekman({
      entities: [orders],
      store: shared,
      now: () => now,
    });
    const b = new Ekman({ entities: [orders], store: shared });

    await a.entities.orders.send("1", { type: "poke" });
    await b.entities.orders.forget("1");
    await a.entities.orders.send("1", { type: "poke" }).catch(() => 0);

    now = 5000;
    await a.entities.orders.send("1", { type: "poke" });

    const { events } = await a.entities.orders.history("1");
    expect(events.find((event) => event.seq === 0)).toMatchObject({
      type: "transition",
      from: null,
      at: 5000,
    });
    await a.close();
    await b.close();
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
    const closeable: Store = Object.assign(memoryStore({ name: "closeable" }), {
      close: () => {
        closed.push("closeable");
        return Promise.resolve();
      },
    });

    const ekman = new Ekman({
      entities: [orders],
      // One layer with a close, one without: the optional method must stay optional.
      store: [closeable, memoryStore({ name: "plain" })],
    });

    await ekman.close();
    expect(closed).toEqual(["closeable"]);
  });
});

describe("reading through a cache layer", () => {
  const stack = () => ({
    cache: memoryStore({ name: "cache" }),
    truth: memoryStore({ name: "truth", authority: true }),
  });

  it("answers a load from the cache without asking the authority", async () => {
    const { cache, truth } = stack();
    const ekman = new Ekman({
      entities: [orders],
      store: [cache, truth],
      memory: { maxBytes: 0 },
    });
    await ekman.entities.orders.send("1", { type: "touch" });
    await settle();
    expect(ekman.residentKeys).toEqual([]);

    const asked = vi.spyOn(truth, "load");
    const sent = await ekman.entities.orders.send("1", { type: "close" });

    expect(sent).toMatchObject({ state: "closed", seq: 2 });
    expect(asked).not.toHaveBeenCalled();
    await ekman.close();
  });

  it("fills a cold cache from the authority, so nothing after a restart fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ekman-cache-"));
    const before = new Ekman({
      entities: [orders],
      store: ["memory", { kind: "file", dir }],
      memory: { maxBytes: 0 },
    });
    await before.entities.orders.send("1", { type: "touch" });
    await before.entities.orders.send("1", { type: "touch" });
    await before.entities.orders.send("2", { type: "touch" });
    await before.close();

    // A new process: the same directory, and a cache with nothing in it.
    const cache = memoryStore({ name: "cache" });
    const truth = fileStore(dir);
    const asked = vi.spyOn(truth, "load");
    const seen: TelemetryEvent[] = [];
    const after = new Ekman({
      entities: [orders],
      store: [cache, truth],
      memory: { maxBytes: 0 },
      telemetry: { "*": (event) => seen.push(event) },
    });

    await after.entities.orders.send("1", { type: "touch" });
    await after.entities.orders.send("1", { type: "close" });
    await settle();

    expect(cacheFailures(seen)).toEqual([]);
    // Asked once, for the miss. The second load was the cache's.
    expect(asked).toHaveBeenCalledTimes(1);
    expect((await cache.load("orders:1"))?.seq).toBe(4);
    expect(replay((await cache.load("orders:1")) as never)).toMatchObject({
      state: "closed",
      seq: 4,
    });
    // History is the authority's, whole, whatever the cache was handed.
    const history = await after.entities.orders.history("1");
    expect(history.events.filter((e) => e.type === "transition")).toHaveLength(
      5
    );

    await after.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("fills a cache that missed from one further back that did not", async () => {
    const near = memoryStore({ name: "near" });
    const far = memoryStore({ name: "far" });
    const truth = memoryStore({ name: "truth", authority: true });
    const first = new Ekman({ entities: [orders], store: [far, truth] });
    await first.entities.orders.send("1", { type: "touch" });
    await first.close();

    const asked = vi.spyOn(truth, "load");
    const second = new Ekman({ entities: [orders], store: [near, far, truth] });
    await second.entities.orders.send("1", { type: "touch" });
    await settle();

    expect(asked).not.toHaveBeenCalled();
    expect((await near.load("orders:1"))?.seq).toBe(2);
    await second.close();
  });

  it("treats a cache that throws as a miss, and says so", async () => {
    const { cache: inner, truth } = stack();
    const cache = wrap(inner, {
      // Not an Error on purpose: an adapter can reject with anything.
      load: () => Promise.reject("the cache is unreachable"),
    });
    const seen: TelemetryEvent[] = [];
    const ekman = new Ekman({
      entities: [orders],
      store: [cache, truth],
      telemetry: { "*": (event) => seen.push(event) },
    });

    await expect(
      ekman.entities.orders.send("1", { type: "close" })
    ).resolves.toMatchObject({ state: "closed", seq: 1 });
    expect(cacheFailures(seen)).toEqual([
      expect.objectContaining({
        store: "cache",
        error: "the cache is unreachable",
      }),
    ]);
    await ekman.close();
  });

  it("does not take a cache's word that a key is new", async () => {
    const { cache, truth } = stack();
    await truth.append("orders:1", elsewhere(0), EMPTY_SEQ);
    await truth.append("orders:1", elsewhere(1), 0);
    // All this cache holds for the key is a refusal, which replays to no state at all.
    await cache.append(
      "orders:1",
      {
        type: "rejected",
        key: "orders:1",
        seq: EMPTY_SEQ,
        at: 0,
        code: "UNKNOWN_TRIGGER",
        reason: "never declared",
        cause: { type: "nonsense", id: "t0" },
      },
      EMPTY_SEQ
    );

    const ekman = new Ekman({ entities: [orders], store: [cache, truth] });
    const sent = await ekman.entities.orders.send("1", { type: "touch" });

    expect(sent.seq).toBe(2);
    await settle();
    expect((await cache.load("orders:1"))?.seq).toBe(2);
    await ekman.close();
  });

  it("never makes a commit, a history read or a shutdown wait for a cache", async () => {
    const { cache: inner, truth } = stack();
    const cache = wrap(inner, {
      append: () => new Promise<void>(() => undefined),
    });
    const ekman = new Ekman({ entities: [orders], store: [cache, truth] });

    await expect(
      ekman.entities.orders.send("1", { type: "close" })
    ).resolves.toMatchObject({ state: "closed" });
    await expect(ekman.entities.orders.history("1")).resolves.toMatchObject({
      complete: false,
    });
    await ekman.close();
  });
});

describe("keeping a cache layer honest", () => {
  const stack = () => ({
    cache: memoryStore({ name: "cache" }),
    truth: memoryStore({ name: "truth", authority: true }),
  });

  it("deletes a key from a cache that missed a write, and leaves it alone until it is filled", async () => {
    const { cache: inner, truth } = stack();
    const append = vi.fn(
      (key: string, event: EkmanEvent, expectedSeq: number): Promise<void> =>
        event.type === "transition" && event.seq === 1
          ? Promise.reject(new Error("cache is gone"))
          : inner.append(key, event, expectedSeq)
    );
    const seen: TelemetryEvent[] = [];
    const ekman = new Ekman({
      entities: [orders],
      store: [wrap(inner, { append }), truth],
      telemetry: { "*": (event) => seen.push(event) },
    });

    await ekman.entities.orders.send("1", { type: "touch" });
    await ekman.entities.orders.send("1", { type: "touch" });
    await settle();

    // One failure, not one per commit since. The key is gone from the cache, so the next
    // load misses, and nothing is appended to a stream with a hole in it.
    expect(cacheFailures(seen)).toHaveLength(1);
    expect(await inner.load("orders:1")).toBeUndefined();
    expect(append).toHaveBeenCalledTimes(2);
    expect((await truth.load("orders:1"))?.seq).toBe(2);
    await ekman.close();
  });

  it("fills that cache again the next time the instance is loaded", async () => {
    const { cache: inner, truth } = stack();
    const cache = wrap(inner, {
      append: (key, event, expectedSeq) =>
        event.type === "transition" && event.seq === 1
          ? Promise.reject(new Error("cache is gone"))
          : inner.append(key, event, expectedSeq),
    });
    const seen: TelemetryEvent[] = [];
    const ekman = new Ekman({
      entities: [orders],
      store: [cache, truth],
      memory: { maxBytes: 0 },
      telemetry: { "*": (event) => seen.push(event) },
    });

    await ekman.entities.orders.send("1", { type: "touch" });
    await ekman.entities.orders.send("1", { type: "touch" });
    await settle();

    expect(cacheFailures(seen)).toHaveLength(1);
    expect((await inner.load("orders:1"))?.seq).toBe(2);
    await ekman.close();
  });

  it("deletes a key from a cache that could not be filled", async () => {
    const { cache: inner, truth } = stack();
    await truth.append("orders:1", elsewhere(0), EMPTY_SEQ);
    const append = vi.fn(inner.append.bind(inner));
    const cache = wrap(inner, {
      append,
      snapshot: () => Promise.reject(new Error("no room")),
    });
    const seen: TelemetryEvent[] = [];
    const ekman = new Ekman({
      entities: [orders],
      store: [cache, truth],
      telemetry: { "*": (event) => seen.push(event) },
    });

    const sent = await ekman.entities.orders.send("1", { type: "touch" });
    await settle();

    expect(sent.seq).toBe(1);
    expect(cacheFailures(seen)).toEqual([
      expect.objectContaining({ store: "cache", error: "no room", seq: 0 }),
    ]);
    expect(append).not.toHaveBeenCalled();
    expect(await inner.load("orders:1")).toBeUndefined();
    await ekman.close();
  });

  it("stops using a cache for a key it can neither write nor clear, until a forget clears it", async () => {
    const { cache: inner, truth } = stack();
    const health: { broken: boolean } = { broken: true };
    const load = vi.fn(inner.load.bind(inner));
    const append = vi.fn(
      (key: string, event: EkmanEvent, expectedSeq: number): Promise<void> =>
        health.broken
          ? Promise.reject(new Error("cache is gone"))
          : inner.append(key, event, expectedSeq)
    );
    const forget = vi.fn(
      (key: string): Promise<void> =>
        health.broken
          ? Promise.reject(new Error("and cannot be cleared"))
          : inner.forget(key)
    );
    const seen: TelemetryEvent[] = [];
    const ekman = new Ekman({
      entities: [orders],
      store: [wrap(inner, { load, append, forget }), truth],
      memory: { maxBytes: 0 },
      telemetry: { "*": (event) => seen.push(event) },
    });

    await ekman.entities.orders.send("1", { type: "touch" });
    await settle();
    expect(cacheFailures(seen).map((event) => event.error)).toEqual([
      "cache is gone",
      "and cannot be cleared",
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);

    // Neither read nor written from here: every send reloads, and none asks the cache.
    await ekman.entities.orders.send("1", { type: "touch" });
    await ekman.entities.orders.send("1", { type: "touch" });
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
    expect(forget).toHaveBeenCalledTimes(1);
    expect(cacheFailures(seen)).toHaveLength(2);

    health.broken = false;
    await ekman.entities.orders.forget("1");
    await ekman.entities.orders.send("1", { type: "touch" });
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect((await inner.load("orders:1"))?.seq).toBe(1);
    await ekman.close();
  });

  it("clears a key another writer moved, reloads from the authority, and fills the cache from that", async () => {
    const { cache, truth } = stack();
    const ekman = new Ekman({ entities: [orders], store: [cache, truth] });
    await ekman.entities.orders.send("1", { type: "touch" });
    await settle();

    await truth.append("orders:1", elsewhere(2), 1);
    await expect(
      ekman.entities.orders.send("1", { type: "touch" })
    ).rejects.toMatchObject({ code: "STORE_CONFLICT" });
    await settle();
    expect(await cache.load("orders:1")).toBeUndefined();

    const asked = vi.spyOn(cache, "load");
    const sent = await ekman.entities.orders.send("1", { type: "close" });
    await settle();
    asked.mockRestore();

    expect(sent).toMatchObject({ state: "closed", seq: 3 });
    expect(asked).not.toHaveBeenCalled();
    expect((await cache.load("orders:1"))?.seq).toBe(3);
    await ekman.close();
  });

  it("recovers from a cache that answered with a state the authority had moved past", async () => {
    const { cache, truth } = stack();
    const ekman = new Ekman({
      entities: [orders],
      store: [cache, truth],
      memory: { maxBytes: 0 },
    });
    await ekman.entities.orders.send("1", { type: "touch" });
    await settle();
    await truth.append("orders:1", elsewhere(2), 1);

    // The cache answers at 1. The authority refuses the commit built on that, which is
    // what stops a stale read from ever becoming a stale write.
    await expect(
      ekman.entities.orders.send("1", { type: "touch" })
    ).rejects.toMatchObject({ code: "STORE_CONFLICT" });
    const sent = await ekman.entities.orders.send("1", { type: "touch" });

    expect(sent).toMatchObject({ seq: 3, values: { n: 1 } });
    await settle();
    expect((await cache.load("orders:1"))?.seq).toBe(3);
    await ekman.close();
  });

  it("starts a key over in the cache when another writer deleted it", async () => {
    const { cache, truth } = stack();
    const ekman = new Ekman({ entities: [orders], store: [cache, truth] });
    await ekman.entities.orders.send("1", { type: "touch" });
    await ekman.entities.orders.send("1", { type: "touch" });
    await settle();

    await truth.forget("orders:1");
    await expect(
      ekman.entities.orders.send("1", { type: "touch" })
    ).rejects.toMatchObject({ code: "STORE_CONFLICT" });
    const sent = await ekman.entities.orders.send("1", { type: "touch" });
    await settle();

    expect(sent.seq).toBe(1);
    expect(await cache.read("orders:1")).toHaveLength(2);
    expect((await cache.load("orders:1"))?.seq).toBe(1);
    await ekman.close();
  });

  it("leaves nothing in a cache when a forget arrives while it is being filled", async () => {
    const { cache: inner, truth } = stack();
    await truth.append("orders:1", elsewhere(0), EMPTY_SEQ);
    const cache = wrap(inner, {
      snapshot: async (key, snapshot) => {
        await new Promise((done) => setTimeout(done, 20));
        await inner.snapshot(key, snapshot);
      },
    });
    const ekman = new Ekman({ entities: [orders], store: [cache, truth] });

    await ekman.entities.orders.send("1", { type: "touch" });
    await ekman.entities.orders.forget("1");
    await new Promise((done) => setTimeout(done, 40));

    expect(inner.keys).toEqual([]);
    expect(await truth.load("orders:1")).toBeUndefined();
    await ekman.close();
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

describe("a second writer", () => {
  /**
   * Two runtimes over one memory store, which is the only way to stage a conflict without
   * an adapter that can genuinely take two processes. The store is shared deliberately: it
   * stands in for the durable layer both runtimes believe they own.
   */
  const twoRuntimes = () => {
    const shared = memoryStore();
    return {
      shared,
      a: new Ekman({ entities: [orders], store: shared }),
      b: new Ekman({ entities: [orders], store: shared }),
    };
  };

  it("lets the loser of a race to create a key recover on its next trigger", async () => {
    const { a, b } = twoRuntimes();

    const [first, second] = await Promise.allSettled([
      a.entities.orders.send("1", { type: "poke" }),
      b.entities.orders.send("1", { type: "poke" }),
    ]);

    expect(first).toMatchObject({ status: "fulfilled", value: { seq: 1 } });
    expect(second).toMatchObject({
      status: "rejected",
      reason: { code: "STORE_CONFLICT" },
    });

    const recovered = await b.entities.orders.send("1", { type: "poke" });
    expect(recovered.seq).toBe(2);
    await a.close();
    await b.close();
  });

  it("reloads before a retry, so the handler decides again on what the other writer left", async () => {
    const shared = memoryStore();
    const seen: number[] = [];
    const restores: TelemetryEvent[] = [];
    const counting = defineEntity("orders", {
      initial: "open",
      states: {
        open: (order) => {
          seen.push(order.seq);
          return stay({ n: order.seq });
        },
      },
    });
    const a = new Ekman({
      entities: [counting],
      store: shared,
      execution: { maxAttempts: 3, backoff: { kind: "fixed", delayMs: 0 } },
      telemetry: { "instance.restored": (event) => restores.push(event) },
    });
    const b = new Ekman({ entities: [orders], store: shared });

    await a.entities.orders.send("1", { type: "poke" });
    await b.entities.orders.send("1", { type: "poke" });
    seen.length = 0;

    const recovered = await a.entities.orders.send("1", { type: "poke" });

    expect(recovered.seq).toBe(3);
    expect(seen).toEqual([1, 2]);
    expect(restores).toHaveLength(1);
    await a.close();
    await b.close();
  });

  it("refuses a retry when the other writer left a state this runtime has no handler for", async () => {
    const shared = memoryStore();
    const narrow = defineEntity("orders", {
      initial: "open",
      states: { open: () => stay({ n: 1 }) },
    });
    const a = new Ekman({
      entities: [narrow],
      store: shared,
      execution: { maxAttempts: 3, backoff: { kind: "fixed", delayMs: 0 } },
    });
    const b = new Ekman({ entities: [orders], store: shared });

    await a.entities.orders.send("1", { type: "poke" });
    await b.entities.orders.send("1", { type: "close" });

    const refused = await a.entities.orders
      .send("1", { type: "poke" })
      .catch((error: EkmanError) => error.code);

    expect(refused).toBe("UNKNOWN_STATE");
    await a.close();
    await b.close();
  });

  it("does not let a retry predicate run a handler for a state the reload moved past", async () => {
    const shared = memoryStore();
    let calls = 0;
    const narrow = defineEntity("orders", {
      initial: "open",
      states: {
        open: () => {
          calls += 1;
          return stay({ n: calls });
        },
      },
    });
    const a = new Ekman({
      entities: [narrow],
      store: shared,
      execution: {
        maxAttempts: 3,
        backoff: { kind: "fixed", delayMs: 0 },
        retryable: () => true,
      },
    });
    const b = new Ekman({ entities: [orders], store: shared });

    await a.entities.orders.send("1", { type: "poke" });
    await b.entities.orders.send("1", { type: "close" });
    calls = 0;

    const refused = await a.entities.orders
      .send("1", { type: "poke" })
      .catch((error: EkmanError) => error.code);

    expect(refused).toBe("UNKNOWN_STATE");
    expect(calls).toBe(1);
    expect((await shared.load("orders:1"))?.seq).toBe(2);
    await a.close();
    await b.close();
  });

  it("surfaces the conflict rather than overwriting the other writer", async () => {
    const { a, b } = twoRuntimes();
    await a.entities.orders.send("1", { type: "poke" });
    // b loads the key at seq 1 and holds it resident.
    await b.entities.orders.send("1", { type: "poke" });
    // a still believes it is at seq 1. It is not: b advanced the key to 2.
    const conflicted = await a.entities.orders
      .send("1", { type: "poke" })
      .catch((error: EkmanError) => error);

    expect((conflicted as EkmanError).code).toBe("STORE_CONFLICT");
    await a.close();
    await b.close();
  });

  it("reloads before the next trigger instead of conflicting forever", async () => {
    const { a, b } = twoRuntimes();
    await a.entities.orders.send("1", { type: "poke" });
    await b.entities.orders.send("1", { type: "poke" });
    await a.entities.orders.send("1", { type: "poke" }).catch(() => undefined);

    // The whole point. Without a reload the cached sequence stays behind forever and
    // every later trigger for this key conflicts too, so one collision would take the key
    // out of service for the lifetime of the process.
    const recovered = await a.entities.orders.send("1", { type: "poke" });

    expect(recovered.seq).toBe(3);
    expect(a.entities.orders.inspect("1")).toMatchObject({ seq: 3 });
    await a.close();
    await b.close();
  });

  it("records the reload in the stream, so a jump in the sequence is explicable", async () => {
    const { a, b } = twoRuntimes();
    await a.entities.orders.send("1", { type: "poke" });
    await b.entities.orders.send("1", { type: "poke" });
    await a.entities.orders.send("1", { type: "poke" }).catch(() => undefined);
    await a.entities.orders.send("1", { type: "poke" });

    // Without this the stream would show a handler deciding against values no earlier
    // event in it accounts for.
    const { events } = await a.entities.orders.history("1");
    const restored = events.filter((event) => event.type === "restored");
    expect(restored.at(-1)).toMatchObject({ cause: { type: "reload" } });
    await a.close();
    await b.close();
  });

  it("reloads through a snapshot the other writer left, not only through the log", async () => {
    const { shared, a, b } = twoRuntimes();
    await a.entities.orders.send("1", { type: "poke" });
    await b.entities.orders.send("1", { type: "poke" });

    // The other writer snapshotted, which is what eviction does on a busy runtime. The
    // reload has to read through it, and say which of the two it came back from.
    await shared.snapshot("orders:1", {
      key: "orders:1",
      entity: "orders",
      state: "open",
      values: { n: 1 },
      seq: 2,
      at: 2000,
      enteredAt: 2000,
    });

    await a.entities.orders.send("1", { type: "poke" }).catch(() => undefined);
    await a.entities.orders.send("1", { type: "poke" });

    const { events } = await a.entities.orders.history("1");
    const restored = events.filter((event) => event.type === "restored");
    expect(restored.at(-1)).toMatchObject({ from: "snapshot" });
    await a.close();
    await b.close();
  });

  it("treats a key the other writer deleted as gone rather than as its old self", async () => {
    const { shared, a, b } = twoRuntimes();
    await a.entities.orders.send("1", { type: "poke" });
    await b.entities.orders.send("1", { type: "poke" });

    // b deletes the key while a still holds it resident at a stale sequence.
    await shared.forget("orders:1");
    await a.entities.orders.send("1", { type: "poke" }).catch(() => undefined);

    // Reloading found nothing, so the next trigger initializes rather than resuming a
    // sequence the store no longer has any record of.
    const revived = await a.entities.orders.send("1", { type: "poke" });
    expect(revived.seq).toBe(1);
    await a.close();
    await b.close();
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

describe("values restored from a store", () => {
  it("are as frozen as the ones a commit produced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ekman-frozen-"));
    const carts = defineEntity("carts", {
      initial: "open",
      states: {
        open: (cart, trigger) => {
          if (trigger.type === "tamper") {
            (cart.values.nested as { n: number }).n = 5;
          }
          return stay({ nested: { n: 1 } });
        },
      },
    });
    const first = new Ekman({ entities: [carts], store: fileStore(dir) });
    await first.entities.carts.send("a", { type: "fill" });
    await first.close();

    const second = new Ekman({ entities: [carts], store: fileStore(dir) });
    const tampering = await second.entities.carts
      .send("a", { type: "tamper" })
      .catch((error: EkmanError) => error.code);

    expect(tampering).toBe("HANDLER_FAILED");
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
