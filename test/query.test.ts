import { describe, expect, it } from "vitest";
import { Ekman } from "../src/ekman";
import { defineEntity } from "../src/entity";
import { isEkmanError } from "../src/errors";
import type { EkmanEvent } from "../src/events";
import { mergeRestores, parseDuration } from "../src/query";
import { stay, transitionTo } from "../src/results";
import type { ScanCriteria, ScanResult, Store } from "../src/store";
import { memoryStore } from "../src/stores/memory";

const code = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isEkmanError(error) ? error.code : "not-an-ekman-error";
  }
  return "no-throw";
};

/**
 * A store that delegates to another, with one behaviour replaced.
 *
 * Spread does not copy prototype methods off a class instance, so every method is bound
 * explicitly. Getting this wrong produces a store that typechecks and has no `append`.
 */
function wrap(inner: Store, overrides: Partial<Store>): Store {
  return {
    name: inner.name,
    capabilities: inner.capabilities,
    append: inner.append.bind(inner),
    load: inner.load.bind(inner),
    read: inner.read.bind(inner),
    snapshot: inner.snapshot.bind(inner),
    scan: inner.scan.bind(inner),
    ...overrides,
  };
}

const clock = (start = 0) => {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
};

const orders = defineEntity("orders", {
  initial: "open",
  states: {
    open: (_i, trigger) =>
      trigger.type === "close" ? transitionTo("closed") : stay(),
    closed: () => stay(),
  },
});

describe("parsing a duration", () => {
  it.each([
    ["500ms", 500],
    ["30s", 30_000],
    ["5m", 300_000],
    ["2h", 7_200_000],
    ["1d", 86_400_000],
    ["1.5m", 90_000],
    ["  5m  ", 300_000],
  ])("reads %s", (value, expected) => {
    expect(parseDuration(value)).toBe(expected);
  });

  it("takes a plain number as milliseconds", () => {
    expect(parseDuration(0)).toBe(0);
    expect(parseDuration(1234)).toBe(1234);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("refuses %s", (value) => {
    expect(code(() => parseDuration(value))).toBe("INVALID_CONFIG");
  });

  it.each(["", "5", "5 m", "5x", "m5", "five minutes"])(
    "refuses %s rather than guessing at it",
    (value) => {
      expect(code(() => parseDuration(value))).toBe("INVALID_CONFIG");
    }
  );
});

describe("weaving restores into a stored stream", () => {
  const transition = (seq: number): EkmanEvent => ({
    type: "transition",
    key: "orders:1",
    from: null,
    to: "open",
    seq,
    at: seq,
    cause: { type: "t", id: `t${seq}` },
    values: {},
  });

  const restored = (seq: number): EkmanEvent => ({
    type: "restored",
    key: "orders:1",
    seq,
    at: seq,
    cause: { type: "t", id: "r" },
    from: "replay",
    replayed: seq + 1,
  });

  const summarize = (events: readonly EkmanEvent[]) =>
    events.map((event) => `${event.type}@${event.seq}`);

  it("returns the stored stream untouched when nothing was restored", () => {
    const stored = [transition(0), transition(1)];
    expect(mergeRestores(stored, [transition(0)])).toBe(stored);
  });

  it("places a restore after everything the store held at or below its sequence", () => {
    const merged = mergeRestores(
      [transition(0), transition(1), transition(2)],
      [restored(1), transition(2)]
    );

    expect(summarize(merged)).toEqual([
      "transition@0",
      "transition@1",
      "restored@1",
      "transition@2",
    ]);
  });

  it("handles several reloads over one key's life", () => {
    const merged = mergeRestores(
      [
        transition(0),
        transition(1),
        transition(2),
        transition(3),
        transition(4),
      ],
      [restored(1), restored(3)]
    );

    expect(summarize(merged)).toEqual([
      "transition@0",
      "transition@1",
      "restored@1",
      "transition@2",
      "transition@3",
      "restored@3",
      "transition@4",
    ]);
  });

  it("puts a restore at the end when nothing followed it", () => {
    const merged = mergeRestores([transition(0)], [restored(0)]);
    expect(summarize(merged)).toEqual(["transition@0", "restored@0"]);
  });
});

describe("querying", () => {
  it("finds nothing for an entity with no instances", async () => {
    const ekman = new Ekman({ entities: [orders] });
    const result = await ekman.query({ entity: "orders" });

    expect(result.instances).toEqual([]);
    expect(result.sources).toEqual(["resident"]);
    await ekman.close();
  });

  it("reports the age of each match", async () => {
    const time = clock();
    const ekman = new Ekman({ entities: [orders], now: time.now });

    await ekman.entities.orders.send("1", { type: "t" });
    time.advance(5000);

    const [match] = (await ekman.entities.orders.query()).instances;
    expect(match).toMatchObject({
      key: "orders:1",
      state: "open",
      ageMs: 5000,
      enteredAt: 0,
      resident: true,
    });
    await ekman.close();
  });

  it("measures age from the last move, not the last commit", async () => {
    const time = clock();
    const ekman = new Ekman({ entities: [orders], now: time.now });

    await ekman.entities.orders.send("1", { type: "t" });
    time.advance(5000);
    // A values-only commit. The instance has not gone anywhere, so its clock keeps running.
    await ekman.entities.orders.send("1", { type: "t" });

    const [match] = (await ekman.entities.orders.query()).instances;
    expect(match?.ageMs).toBe(5000);
    await ekman.close();
  });

  it("narrows to one entity", async () => {
    const carts = defineEntity("carts", {
      initial: "open",
      states: { open: () => stay() },
    });
    const ekman = new Ekman({ entities: [orders, carts] });

    await ekman.entities.orders.send("1", { type: "t" });
    await ekman.entities.carts.send("1", { type: "t" });

    expect(
      (await ekman.query({ entity: "orders" })).instances.map((i) => i.key)
    ).toEqual(["orders:1"]);
    await ekman.close();
  });

  it("prefers the resident view of a key the store also knows about", async () => {
    const time = clock();
    const store = memoryStore();
    const ekman = new Ekman({ entities: [orders], store, now: time.now });

    await ekman.entities.orders.send("1", { type: "close" });

    const result = await ekman.query({ entity: "orders" });
    // One entry, not two, and the resident one: an instance in memory is by definition
    // more current than the store's picture of it.
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0]).toMatchObject({
      key: "orders:1",
      state: "closed",
      resident: true,
    });
    expect(result.sources).toEqual(["resident", "memory"]);
    await ekman.close();
  });

  it("finds an evicted instance through the store", async () => {
    const store = memoryStore();
    const ekman = new Ekman({
      entities: [orders],
      store,
      memory: { maxBytes: 0 },
    });

    await ekman.entities.orders.send("1", { type: "close" });
    expect(ekman.residentKeys).toEqual([]);

    const result = await ekman.query({ entity: "orders", state: "closed" });
    expect(result.instances[0]).toMatchObject({
      key: "orders:1",
      state: "closed",
      resident: false,
    });
    await ekman.close();
  });

  it("reports an ephemeral store as partial, because a restart loses it", async () => {
    const ekman = new Ekman({ entities: [orders], store: memoryStore() });
    await ekman.entities.orders.send("1", { type: "t" });

    const result = await ekman.query({ entity: "orders" });
    expect(result.complete).toBe(false);
    expect(result.reasons).toEqual(["no-durable-store"]);
    await ekman.close();
  });

  it("applies a filter the store could not, and says the answer is partial", async () => {
    // A store that returns everything and admits it ignored the filters. The runtime has
    // to finish the job rather than hand back rows nobody asked for.
    const inner = memoryStore();
    const blunt = wrap(inner, {
      capabilities: {
        ...inner.capabilities,
        scan: { byState: false, olderThan: false },
      },
      scan: async (criteria: ScanCriteria): Promise<ScanResult> => {
        const all = await inner.scan({
          entity: criteria.entity,
          now: criteria.now,
        });
        return { ...all, unsupported: ["state", "olderThan"] };
      },
    });

    const time = clock();
    const ekman = new Ekman({
      entities: [orders],
      store: blunt,
      memory: { maxBytes: 0 },
      now: time.now,
    });

    await ekman.entities.orders.send("open-one", { type: "t" });
    await ekman.entities.orders.send("closed-one", { type: "close" });
    time.advance(5000);

    const result = await ekman.query({ entity: "orders", state: "open" });
    expect(result.instances.map((i) => i.key)).toEqual(["orders:open-one"]);
    expect(result.reasons).toContain("unsupported-criteria");
    expect(result.complete).toBe(false);

    const aged = await ekman.query({ entity: "orders", olderThan: 10_000 });
    expect(aged.instances).toEqual([]);
    await ekman.close();
  });

  it("reports a store that truncated its own scan", async () => {
    const inner = memoryStore();
    const truncating = wrap(inner, {
      scan: async (criteria: ScanCriteria): Promise<ScanResult> => ({
        ...(await inner.scan(criteria)),
        complete: false,
      }),
    });

    const ekman = new Ekman({
      entities: [orders],
      store: truncating,
      memory: { maxBytes: 0 },
    });
    await ekman.entities.orders.send("1", { type: "t" });

    expect((await ekman.query({ entity: "orders" })).reasons).toContain(
      "limit-reached"
    );
    await ekman.close();
  });

  it("breaks ties on the key, so a limited answer is the same answer twice", async () => {
    const time = clock();
    const ekman = new Ekman({ entities: [orders], now: time.now });

    // All three enter at the same instant, so age cannot order them.
    await ekman.entities.orders.send("c", { type: "t" });
    await ekman.entities.orders.send("a", { type: "t" });
    await ekman.entities.orders.send("b", { type: "t" });

    const result = await ekman.query({ entity: "orders" });
    expect(result.instances.map((i) => i.key)).toEqual([
      "orders:a",
      "orders:b",
      "orders:c",
    ]);
    await ekman.close();
  });
});

describe("reading history", () => {
  it("reports nothing for a key that never existed", async () => {
    const ekman = new Ekman({ entities: [orders], store: memoryStore() });
    const history = await ekman.history("orders:never");

    expect(history.events).toEqual([]);
    expect(history.key).toBe("orders:never");
    await ekman.close();
  });

  it("waits for a refusal to reach the store before reading it back", async () => {
    // Refusals are written without being awaited. Without the flush, a read taken right
    // afterwards could return a stream with a hole in it.
    const strict = defineEntity("strict", {
      initial: "open",
      triggers: ["known"],
      states: { open: () => stay() },
    });

    const ekman = new Ekman({
      entities: [strict],
      store: memoryStore(),
      inbox: { recordOverflow: true },
    });

    await ekman.entities.strict
      .send("1", { type: "unrecognized" })
      .catch(() => undefined);

    const { events } = await ekman.entities.strict.history("1");
    expect(events.map((event) => event.type)).toEqual([
      "transition",
      "rejected",
    ]);
    await ekman.close();
  });
});
