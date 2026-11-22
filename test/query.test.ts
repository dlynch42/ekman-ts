import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Ekman } from "../src/ekman";
import { defineEntity } from "../src/entity";
import { isEkmanError } from "../src/errors";
import type { EkmanEvent } from "../src/events";
import { mergeRestores, parseDuration } from "../src/query";
import { stay, transitionTo } from "../src/results";
import type { ScanCriteria, ScanResult, Store } from "../src/store";
import { fileStore } from "../src/stores/file";
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

  it("prefers the resident view even when a store returns the key it was told to leave out", async () => {
    const inner = memoryStore();
    const unhelpful = wrap(inner, {
      scan: (criteria: ScanCriteria): Promise<ScanResult> =>
        inner.scan({ entity: criteria.entity, now: criteria.now }),
    });
    const ekman = new Ekman({ entities: [orders], store: unhelpful });

    await ekman.entities.orders.send("1", { type: "close" });

    const result = await ekman.query({ entity: "orders" });
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0]).toMatchObject({
      key: "orders:1",
      resident: true,
    });
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

  it("holds a store to what it declared, when its answer forgets to say so", async () => {
    // Declares that it cannot filter, hands back every row, and reports nothing as
    // unsupported. The declaration is enough for the runtime to finish the filter.
    const inner = memoryStore();
    const forgetful = wrap(inner, {
      capabilities: {
        ...inner.capabilities,
        scan: { byState: false, olderThan: false },
      },
      scan: (criteria: ScanCriteria): Promise<ScanResult> =>
        inner.scan({ entity: criteria.entity, now: criteria.now }),
    });

    const time = clock();
    const ekman = new Ekman({
      entities: [orders],
      store: forgetful,
      memory: { maxBytes: 0 },
      now: time.now,
    });
    await ekman.entities.orders.send("open-one", { type: "t" });
    await ekman.entities.orders.send("closed-one", { type: "close" });
    time.advance(5000);

    const result = await ekman.query({ entity: "orders", state: "open" });
    expect(result.instances.map((i) => i.key)).toEqual(["orders:open-one"]);
    expect(result.reasons).toContain("unsupported-criteria");

    const aged = await ekman.query({ entity: "orders", olderThan: 10_000 });
    expect(aged.instances).toEqual([]);
    expect(aged.reasons).toContain("unsupported-criteria");

    // Nothing was asked that it cannot do, so nothing is reported.
    const all = await ekman.query({ entity: "orders" });
    expect(all.instances).toHaveLength(2);
    expect(all.reasons).not.toContain("unsupported-criteria");
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

  it("orders tied keys as plain strings, the same on every machine", async () => {
    const ekman = new Ekman({ entities: [orders], now: () => 0 });

    await ekman.entities.orders.send("a", { type: "t" });
    await ekman.entities.orders.send("B", { type: "t" });

    // A locale-aware comparison would put `a` first.
    const result = await ekman.query({ entity: "orders" });
    expect(result.instances.map((i) => i.key)).toEqual([
      "orders:B",
      "orders:a",
    ]);
    await ekman.close();
  });

  it("does not ask the store about a key it already answered from memory", async () => {
    const store = memoryStore();
    const ekman = new Ekman({ entities: [orders], store });
    await ekman.entities.orders.send("1", { type: "t" });
    await ekman.entities.orders.send("2", { type: "close" });

    const load = vi.spyOn(store, "load");
    const result = await ekman.query({ entity: "orders", state: "open" });

    expect(result.instances.map((i) => i.key)).toEqual(["orders:1"]);
    expect(load.mock.calls.map(([key]) => key)).toEqual(["orders:2"]);
    await ekman.close();
  });

  it("still answers from the store for a resident key another writer has moved", async () => {
    const store = memoryStore();
    const here = new Ekman({ entities: [orders], store });
    const elsewhere = new Ekman({ entities: [orders], store });

    await here.entities.orders.send("1", { type: "t" });
    await elsewhere.entities.orders.send("1", { type: "close" });

    // Resident here as `open`, which does not match, so the stored row is the answer.
    expect(here.entities.orders.inspect("1")?.state).toBe("open");
    const result = await here.query({ entity: "orders", state: "closed" });
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0]).toMatchObject({
      key: "orders:1",
      state: "closed",
      resident: false,
    });
    await here.close();
    await elsewhere.close();
  });

  it("picks the oldest few out of many without changing which they are", async () => {
    const time = clock();
    const ekman = new Ekman({ entities: [orders], now: time.now });
    const ids = Array.from({ length: 999 }, (_, n) =>
      String(n).padStart(3, "0")
    );

    await ekman.entities.orders.send("zz-first", { type: "t" });
    time.advance(1000);
    // Sent last key first, so nothing arrives already in order.
    await Promise.all(
      ids.reverse().map((id) => ekman.entities.orders.send(id, { type: "t" }))
    );
    time.advance(1000);

    const everything = await ekman.query({ entity: "orders" });
    const limited = await ekman.query({ entity: "orders", limit: 3 });

    expect(everything.instances).toHaveLength(1000);
    expect(everything.reasons).not.toContain("limit-reached");
    expect(limited.instances.map((i) => i.key)).toEqual([
      "orders:zz-first",
      "orders:000",
      "orders:001",
    ]);
    expect(limited.instances).toEqual(everything.instances.slice(0, 3));
    expect(limited.reasons).toContain("limit-reached");

    // Small limits and large ones are picked two different ways, and have to agree.
    for (const limit of [64, 65, 999]) {
      // biome-ignore lint/performance/noAwaitInLoops: one query at a time is the point of comparing them
      const cut = await ekman.query({ entity: "orders", limit });
      expect(cut.instances).toEqual(everything.instances.slice(0, limit));
      expect(cut.reasons).toContain("limit-reached");
    }
    await ekman.close();
  });

  it("reports a limit as reached only when it left something out", async () => {
    const ekman = new Ekman({ entities: [orders], now: () => 0 });
    await ekman.entities.orders.send("1", { type: "t" });
    await ekman.entities.orders.send("2", { type: "t" });

    const exact = await ekman.query({ entity: "orders", limit: 2 });
    expect(exact.instances).toHaveLength(2);
    expect(exact.reasons).not.toContain("limit-reached");

    const none = await ekman.query({ entity: "orders", limit: 0 });
    expect(none.instances).toEqual([]);
    expect(none.reasons).toContain("limit-reached");
    await ekman.close();
  });

  it.each([-1, 1.5, Number.NaN, "3"])(
    "refuses a limit of %s rather than guessing at it",
    async (limit) => {
      const ekman = new Ekman({ entities: [orders] });

      await expect(
        ekman.query({ entity: "orders", limit: limit as number })
      ).rejects.toMatchObject({
        code: "INVALID_CONFIG",
        message: expect.stringContaining("non-negative integer"),
      });
      await ekman.close();
    }
  );
});

const services = defineEntity("services", {
  initial: "healthy",
  values: { errorRate: 0 },
  states: {
    healthy: (_i, trigger) => {
      if (trigger.type === "degrade") {
        return transitionTo("degraded", { errorRate: 0.2 });
      }
      if (trigger.type === "lose") {
        return transitionTo("unreachable", { errorRate: 1 });
      }
      return stay({
        errorRate: (trigger.errorRate as number | undefined) ?? 0,
      });
    },
    degraded: () => stay(),
    unreachable: () => stay(),
  },
});

/** One instance kept in memory and one left to the store, both committed to it. */
async function oneResidentOneStored(store: Store, now = () => 0) {
  const first = new Ekman({ entities: [services], store, now });
  await first.entities.services.send("stored", { type: "degrade" });
  await first.close();

  const ekman = new Ekman({ entities: [services], store, now });
  await ekman.entities.services.send("resident", {
    type: "probe",
    errorRate: 0.01,
  });
  expect(ekman.residentKeys).toEqual(["services:resident"]);
  return ekman;
}

describe("carrying values", () => {
  it("leaves values out unless they are asked for", async () => {
    const ekman = await oneResidentOneStored(memoryStore());

    const { instances } = await ekman.query({ entity: "services" });
    expect(instances).toHaveLength(2);
    for (const match of instances) {
      expect("values" in match).toBe(false);
    }
    await ekman.close();
  });

  it("carries values for resident and stored matches when asked", async () => {
    const ekman = await oneResidentOneStored(memoryStore());

    const { instances } = await ekman.query({
      entity: "services",
      includeValues: true,
    });
    expect(
      Object.fromEntries(instances.map((m) => [m.key, [m.resident, m.values]]))
    ).toEqual({
      "services:resident": [true, { errorRate: 0.01 }],
      "services:stored": [false, { errorRate: 0.2 }],
    });
    await ekman.close();
  });

  it("types a handle's matches by the entity's states and values", async () => {
    const ekman = new Ekman({ entities: [services] });
    await ekman.entities.services.send("1", { type: "probe", errorRate: 0.5 });

    const { instances } = await ekman.entities.services.query({
      state: "healthy",
      includeValues: true,
      where: (values) => values.errorRate > 0.1,
    });
    const rate: number | undefined = instances[0]?.values?.errorRate;
    expect(rate).toBe(0.5);

    const state: "healthy" | "degraded" | "unreachable" | undefined =
      instances[0]?.state;
    expect(state).toBe("healthy");

    // @ts-expect-error "helthy" is not a state this entity has
    const misspelt = await ekman.entities.services.query({ state: "helthy" });
    expect(misspelt.instances).toEqual([]);
    await ekman.close();
  });

  it("reads the values itself when a store returns a match without them", async () => {
    // A store written before `includeValues` existed ignores it. The answer still has to
    // carry values, so the runtime loads the keys that arrived without any.
    const inner = memoryStore();
    const loads: string[] = [];
    const unaware = wrap(inner, {
      load: (key) => {
        loads.push(key);
        return inner.load(key);
      },
      scan: ({ includeValues: _ignored, ...criteria }) => inner.scan(criteria),
    });
    const ekman = await oneResidentOneStored(unaware);
    loads.length = 0;

    const { instances } = await ekman.query({
      entity: "services",
      includeValues: true,
    });
    expect(instances.find((m) => !m.resident)?.values).toEqual({
      errorRate: 0.2,
    });
    expect(loads).toEqual(["services:stored"]);
    await ekman.close();
  });

  it("loads only the matches that came without values", async () => {
    const inner = memoryStore();
    const loads: string[] = [];
    const patchy = wrap(inner, {
      load: (key) => {
        loads.push(key);
        return inner.load(key);
      },
      scan: async (criteria) => {
        const found = await inner.scan(criteria);
        return {
          ...found,
          matches: found.matches.map((match) => {
            if (match.key === "services:a") {
              return match;
            }
            const { values: _dropped, ...bare } = match;
            return bare;
          }),
        };
      },
    });
    const first = new Ekman({ entities: [services], store: patchy });
    await first.entities.services.send("a", { type: "degrade" });
    await first.entities.services.send("b", { type: "lose" });
    await first.close();

    const ekman = new Ekman({ entities: [services], store: patchy });
    loads.length = 0;
    const { instances } = await ekman.query({
      entity: "services",
      includeValues: true,
    });

    expect(instances.map((m) => m.values)).toEqual([
      { errorRate: 0.2 },
      { errorRate: 1 },
    ]);
    expect(loads).toEqual(["services:b"]);
    await ekman.close();
  });

  it("describes one committed revision when a key commits between the scan and the read", async () => {
    // The store's scan leaves values out, and by the time the runtime reads them the key
    // has moved on. What comes back has to be the newer revision or nothing: never the
    // old state and sequence with the new values laid over them.
    const inner = memoryStore();
    const first = new Ekman({ entities: [services], store: inner });
    await first.entities.services.send("a", { type: "probe", errorRate: 0.5 });
    await first.entities.services.send("b", { type: "probe", errorRate: 0.5 });
    await first.close();

    const racing = wrap(inner, {
      scan: async ({ includeValues: _ignored, ...criteria }) => {
        const found = await inner.scan(criteria);
        // Another writer, after the scan was answered and before anything is loaded.
        const other = new Ekman({ entities: [services], store: inner });
        await other.entities.services.send("a", { type: "degrade" });
        await other.entities.services.send("b", {
          type: "probe",
          errorRate: 0.9,
        });
        await other.close();
        return found;
      },
    });
    const ekman = new Ekman({ entities: [services], store: racing });

    const { instances } = await ekman.query({
      entity: "services",
      state: "healthy",
      includeValues: true,
    });

    // `a` left the state that was asked about, so it is no longer a match. `b` stayed,
    // and is reported at the sequence its values belong to.
    expect(instances.map((m) => [m.key, m.state, m.seq, m.values])).toEqual([
      ["services:b", "healthy", 2, { errorRate: 0.9 }],
    ]);
    await ekman.close();
  });

  it("holds a revision read late to the time in state that was asked for", async () => {
    const inner = memoryStore();
    const time = clock();
    const first = new Ekman({
      entities: [services],
      store: inner,
      now: time.now,
    });
    await first.entities.services.send("a", { type: "probe" });
    await first.close();
    time.advance(10_000);

    const racing = wrap(inner, {
      scan: async ({ includeValues: _ignored, ...criteria }) => {
        const found = await inner.scan(criteria);
        const other = new Ekman({
          entities: [services],
          store: inner,
          now: time.now,
        });
        // A move, so its time in state starts again.
        await other.entities.services.send("a", { type: "degrade" });
        await other.close();
        return found;
      },
    });
    const ekman = new Ekman({
      entities: [services],
      store: racing,
      now: time.now,
    });

    const { instances } = await ekman.query({
      entity: "services",
      olderThan: 5000,
      includeValues: true,
    });
    expect(instances).toEqual([]);
    await ekman.close();
  });

  it("drops a match whose key is gone by the time its values are read", async () => {
    const inner = memoryStore();
    const vanishing = wrap(inner, {
      load: () => Promise.resolve(undefined),
      scan: ({ includeValues: _ignored, ...criteria }) => inner.scan(criteria),
    });
    const first = new Ekman({ entities: [services], store: inner });
    await first.entities.services.send("gone", { type: "degrade" });
    await first.close();

    const ekman = new Ekman({ entities: [services], store: vanishing });
    const { instances } = await ekman.query({
      entity: "services",
      includeValues: true,
    });
    expect(instances).toEqual([]);
    await ekman.close();
  });

  it("does not pass on values a store returned without being asked", async () => {
    const inner = memoryStore();
    const eager = wrap(inner, {
      scan: (criteria) => inner.scan({ ...criteria, includeValues: true }),
    });
    const ekman = await oneResidentOneStored(eager);

    const { instances } = await ekman.query({ entity: "services" });
    const stored = instances.find((m) => !m.resident);
    expect(stored?.key).toBe("services:stored");
    expect(stored !== undefined && "values" in stored).toBe(false);
    await ekman.close();
  });

  it("finishes a filter the store could not and still carries values", async () => {
    const inner = memoryStore();
    const blunt = wrap(inner, {
      capabilities: {
        ...inner.capabilities,
        scan: { byState: false, olderThan: false },
      },
      scan: ({ state: _state, includeValues: _values, ...criteria }) =>
        inner.scan(criteria),
    });
    const ekman = await oneResidentOneStored(blunt);

    const result = await ekman.query({
      entity: "services",
      state: "degraded",
      includeValues: true,
    });
    expect(result.instances.map((m) => [m.key, m.values])).toEqual([
      ["services:stored", { errorRate: 0.2 }],
    ]);
    expect(result.reasons).toContain("unsupported-criteria");
    await ekman.close();
  });
});

describe("filtering by values", () => {
  it("keeps only the instances whose values pass, wherever they are", async () => {
    const ekman = await oneResidentOneStored(memoryStore());
    await ekman.entities.services.send("calm", { type: "probe" });

    const result = await ekman.query({
      entity: "services",
      where: (values) => (values.errorRate as number) > 0.005,
    });
    expect(result.instances.map((m) => m.key).sort()).toEqual([
      "services:resident",
      "services:stored",
    ]);
    await ekman.close();
  });

  it("is an exact answer, so it is no reason for a partial one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ekman-where-"));
    const ekman = await oneResidentOneStored(fileStore(dir));

    const result = await ekman.query({
      entity: "services",
      where: (values) => (values.errorRate as number) > 0.1,
    });
    expect(result.instances.map((m) => m.key)).toEqual(["services:stored"]);
    expect(result.complete).toBe(true);
    expect(result.reasons).toEqual([]);

    await ekman.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads values to filter without carrying them in the answer", async () => {
    const ekman = await oneResidentOneStored(memoryStore());

    const { instances } = await ekman.query({
      entity: "services",
      where: () => true,
    });
    expect(instances).toHaveLength(2);
    for (const match of instances) {
      expect("values" in match).toBe(false);
    }
    await ekman.close();
  });

  it("carries values as well when both are asked for", async () => {
    const ekman = await oneResidentOneStored(memoryStore());

    const { instances } = await ekman.query({
      entity: "services",
      includeValues: true,
      where: (values) => (values.errorRate as number) > 0.1,
    });
    expect(instances.map((m) => m.values)).toEqual([{ errorRate: 0.2 }]);
    await ekman.close();
  });

  it("applies the limit to what passed, not to what was looked at", async () => {
    const time = clock();
    const ekman = new Ekman({ entities: [services], now: time.now });
    await ekman.entities.services.send("old", { type: "probe" });
    time.advance(1000);
    await ekman.entities.services.send("mid", { type: "degrade" });
    time.advance(1000);
    await ekman.entities.services.send("new", { type: "lose" });

    const result = await ekman.query({
      entity: "services",
      where: (values) => (values.errorRate as number) > 0,
      limit: 1,
    });
    expect(result.instances.map((m) => m.key)).toEqual(["services:mid"]);
    expect(result.reasons).toContain("limit-reached");
    await ekman.close();
  });

  it("fails the query when the filter throws", async () => {
    const ekman = new Ekman({ entities: [services] });
    await ekman.entities.services.send("1", { type: "probe" });

    await expect(
      ekman.query({
        entity: "services",
        where: () => {
          throw new Error("broken filter");
        },
      })
    ).rejects.toThrow("broken filter");
    await ekman.close();
  });
});

describe("the state map", () => {
  async function fleet(store?: Store) {
    const time = clock();
    const ekman = new Ekman({
      entities: [services],
      now: time.now,
      ...(store === undefined ? {} : { store }),
    });
    await ekman.entities.services.send("a", { type: "probe" });
    time.advance(1000);
    await ekman.entities.services.send("b", { type: "degrade" });
    time.advance(1000);
    await ekman.entities.services.send("e", { type: "degrade" });
    await ekman.entities.services.send("d", { type: "lose" });
    await ekman.entities.services.send("c", { type: "probe" });
    return ekman;
  }

  it("is built from the runtime's own query, so wrapping one changes the other", async () => {
    const ekman = await fleet();
    const query = ekman.query.bind(ekman);
    const asked = vi
      .spyOn(ekman, "query")
      .mockImplementation(async (criteria) => {
        const found = await query(criteria);
        return {
          ...found,
          instances: found.instances.filter(
            (instance) => instance.key !== "services:a"
          ),
        };
      });

    const byRuntime = await ekman.map("services");
    const byHandle = await ekman.entities.services.map();

    expect(asked).toHaveBeenCalledTimes(2);
    expect(byRuntime.total).toBe(4);
    expect(byRuntime.byState.healthy).toEqual({
      count: 1,
      keys: ["services:c"],
    });
    expect(byHandle).toEqual(byRuntime);
  });

  it("counts and lists every instance by state, oldest in state first", async () => {
    const ekman = await fleet();

    const map = await ekman.map("services");
    expect(map).toEqual({
      entity: "services",
      byState: {
        healthy: { count: 2, keys: ["services:a", "services:c"] },
        degraded: { count: 2, keys: ["services:b", "services:e"] },
        unreachable: { count: 1, keys: ["services:d"] },
      },
      total: 5,
      complete: false,
      reasons: ["no-durable-store"],
      sources: ["resident"],
    });
    await ekman.close();
  });

  it("has no entry for a state nothing is in", async () => {
    const ekman = new Ekman({ entities: [services] });
    await ekman.entities.services.send("a", { type: "probe" });

    const map = await ekman.map("services");
    expect(Object.keys(map.byState)).toEqual(["healthy"]);
    expect(map.byState.degraded).toBeUndefined();
    await ekman.close();
  });

  it("is empty for an entity with no instances", async () => {
    const ekman = new Ekman({ entities: [services] });

    expect(await ekman.map("services")).toMatchObject({
      byState: {},
      total: 0,
    });
    await ekman.close();
  });

  it("lists at most the limit per state, keeps the counts whole, and says so", async () => {
    const ekman = await fleet();

    const map = await ekman.map("services", { limitPerState: 1 });
    expect(map.byState).toEqual({
      healthy: { count: 2, keys: ["services:a"] },
      degraded: { count: 2, keys: ["services:b"] },
      unreachable: { count: 1, keys: ["services:d"] },
    });
    expect(map.total).toBe(5);
    expect(map.reasons).toEqual(["no-durable-store", "limit-reached"]);
    await ekman.close();
  });

  it("reports a limit as reached only when it left a key out", async () => {
    const ekman = await fleet();

    const map = await ekman.map("services", { limitPerState: 2 });
    expect(map.reasons).toEqual(["no-durable-store"]);
    await ekman.close();
  });

  it.each([-1, 1.5, Number.NaN, "3"])(
    "refuses a limit per state of %s",
    async (limitPerState) => {
      const ekman = new Ekman({ entities: [services] });

      await expect(
        ekman.map("services", { limitPerState: limitPerState as number })
      ).rejects.toMatchObject({
        code: "INVALID_CONFIG",
        message: expect.stringContaining("limitPerState"),
      });
      await ekman.close();
    }
  );

  it("refuses an entity that was never defined", async () => {
    const ekman = new Ekman({ entities: [services] });

    await expect(ekman.map("carts")).rejects.toMatchObject({
      code: "UNKNOWN_ENTITY",
    });
    expect(code(() => ekman.residentMap("carts"))).toBe("UNKNOWN_ENTITY");
    await ekman.close();
  });

  it("counts an evicted instance under the state the store holds, and is complete over a durable store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ekman-map-"));
    const ekman = await oneResidentOneStored(fileStore(dir));

    const map = await ekman.map("services");
    expect(map.byState).toEqual({
      healthy: { count: 1, keys: ["services:resident"] },
      degraded: { count: 1, keys: ["services:stored"] },
    });
    expect(map.complete).toBe(true);
    expect(map.reasons).toEqual([]);
    expect(map.sources).toEqual(["resident", "file"]);

    await ekman.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is incomplete whenever a query over the entity would be", async () => {
    const inner = memoryStore();
    const truncating = wrap(inner, {
      scan: async (criteria) => ({
        ...(await inner.scan(criteria)),
        complete: false,
      }),
    });
    const ekman = await oneResidentOneStored(truncating);

    const map = await ekman.map("services", { limitPerState: 0 });
    expect(map.total).toBe(2);
    expect(map.complete).toBe(false);
    // Reported once, though the store and the per-state limit both truncated.
    expect(map.reasons).toEqual(["limit-reached", "no-durable-store"]);
    await ekman.close();
  });

  it("keeps a state with a name an object treats specially as an ordinary entry", async () => {
    // Every object already has a `constructor`, so grouping into a plain object would
    // find one there before the first instance was counted.
    const odd = defineEntity("odd", {
      initial: "constructor",
      states: { constructor: () => stay() },
    });
    const ekman = new Ekman({ entities: [odd] });
    await ekman.send("odd:1", { type: "t" });

    const map = await ekman.map("odd");
    expect(map.byState).toEqual({
      constructor: { count: 1, keys: ["odd:1"] },
    });
    await ekman.close();
  });

  it("reads a state nothing is in as absent, even one named like something every object has", async () => {
    const odd = defineEntity("odd", {
      initial: "open",
      states: { open: () => stay(), constructor: () => stay() },
    });
    const ekman = new Ekman({ entities: [odd] });
    await ekman.send("odd:1", { type: "t" });

    const map = await ekman.entities.odd.map();
    expect(map.byState.constructor).toBeUndefined();
    expect(map.byState.open?.count).toBe(1);
    expect(ekman.residentMap("odd").byState.constructor).toBeUndefined();
    await ekman.close();
  });

  it("is typed by the entity's states on a handle", async () => {
    const ekman = new Ekman({ entities: [services] });
    await ekman.entities.services.send("a", { type: "degrade" });

    const map = await ekman.entities.services.map({ limitPerState: 5 });
    expect(map.byState.degraded?.count).toBe(1);
    // @ts-expect-error "broken" is not a state this entity has
    expect(map.byState.broken).toBeUndefined();
    await ekman.close();
  });

  describe("of what is resident", () => {
    it("answers synchronously from memory alone, and says that is all it asked", async () => {
      const ekman = await oneResidentOneStored(memoryStore());

      const map = ekman.residentMap("services");
      expect(map).toEqual({
        entity: "services",
        byState: {
          healthy: { count: 1, keys: ["services:resident"] },
        },
        total: 1,
        complete: false,
        reasons: ["resident-only"],
        sources: ["resident"],
      });
      await ekman.close();
    });

    it("orders each state oldest first, like the full map", async () => {
      const ekman = await fleet();

      expect(ekman.residentMap("services").byState).toEqual(
        (await ekman.map("services")).byState
      );
      await ekman.close();
    });

    it("is never complete, even with nothing evicted and no store", async () => {
      const ekman = new Ekman({ entities: [services] });
      await ekman.entities.services.send("a", { type: "probe" });

      expect(ekman.residentMap("services").complete).toBe(false);
      await ekman.close();
    });
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
