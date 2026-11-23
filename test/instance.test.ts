import { describe, expect, it } from "vitest";
import { EkmanError } from "../src/errors";
import { isTransitionEvent } from "../src/events";
import { InstanceRecord, RESIDENT_HISTORY_LIMIT } from "../src/instance";
import { States } from "../src/states";
import { memoryStore } from "../src/stores/memory";
import { freezeValues, sealValues } from "../src/values";
import { testDeps } from "./deps";

const deps = testDeps();

/**
 * Commit the way dispatch does: through a token issued for the attempt.
 *
 * The fence is not optional, so a test cannot commit without one either. That is the
 * point of putting the check inside `commit` rather than beside it.
 */
const commit = (
  instance: InstanceRecord<string, Record<string, unknown>>,
  next: Parameters<InstanceRecord<string, Record<string, unknown>>["commit"]>[0]
) => instance.commit(next, instance.issueToken(1));

/** Widened like the records below: these tests commit to states beyond the declared ones. */
const STATES = new States(["pending", "approved", "shipped"]);

const make = (values: Record<string, unknown> = {}) =>
  // Widened on purpose: these tests commit to states beyond the initial one.
  new InstanceRecord<string, Record<string, unknown>>({
    key: "orders:1",
    entity: "orders",
    initial: "pending",
    initialValues: Object.freeze(values),
    states: STATES,
    at: 1000,
    cause: { type: "init", id: "t1" },
    deps,
  });

describe("InstanceRecord", () => {
  it("starts at sequence zero with an initialization event", () => {
    const instance = make();

    expect(instance.state).toBe("pending");
    expect(instance.seq).toBe(0);
    expect(instance.events).toHaveLength(1);
    expect(instance.events[0]).toMatchObject({
      from: null,
      to: "pending",
      seq: 0,
      at: 1000,
    });
  });

  it("is already reconciled when there is no store to reconcile with", async () => {
    const instance = make();

    expect(instance.needsHydration).toBe(false);
    // Idempotent and free: a memory-only runtime never waits on the way in, which is what
    // keeps its dispatch in the same turn it has always been in.
    await instance.ready();
    await instance.ready();

    expect(instance.events).toHaveLength(1);
  });

  it("stays free to call once it has reconciled with a store", async () => {
    const stored = testDeps({ store: memoryStore() });
    const instance = new InstanceRecord<string, Record<string, unknown>>({
      key: "orders:1",
      entity: "orders",
      initial: "pending",
      initialValues: Object.freeze({}),
      states: STATES,
      at: 1000,
      cause: { type: "init", id: "t1" },
      deps: stored,
    });

    expect(instance.needsHydration).toBe(true);
    await instance.ready();

    // "Safe to await from anywhere" has to keep being true after the reconciling is done,
    // or every caller would need to know which of the two states the record is in.
    expect(instance.needsHydration).toBe(false);
    await instance.ready();
    expect(instance.seq).toBe(0);
    expect(instance.events).toEqual([]);
  });

  it("exposes a frozen snapshot", () => {
    const snapshot = make({ a: 1 }).snapshot();

    expect(snapshot).toEqual({
      key: "orders:1",
      entity: "orders",
      state: "pending",
      values: { a: 1 },
      seq: 0,
      enteredAt: 1000,
      lastCommittedAt: 1000,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("advances the sequence by exactly one per commit", async () => {
    const instance = make();

    await commit(instance, {
      state: "approved",
      values: {},
      at: 2000,
      cause: { type: "approve", id: "t2" },
    });
    await commit(instance, {
      state: "shipped",
      values: {},
      at: 3000,
      cause: { type: "ship", id: "t3" },
    });

    expect(instance.seq).toBe(2);
    expect(instance.events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("applies state, values, sequence and event together", async () => {
    const instance = make();
    const event = await commit(instance, {
      state: "approved",
      values: Object.freeze({ by: "amy" }),
      at: 2000,
      cause: { type: "approve", id: "t2" },
    });

    expect(instance.state).toBe("approved");
    expect(instance.values).toEqual({ by: "amy" });
    expect(instance.seq).toBe(event.seq);
    expect(instance.events.at(-1)).toBe(event);
  });

  it("records the state it moved from", async () => {
    const instance = make();
    const event = await commit(instance, {
      state: "approved",
      values: {},
      at: 2000,
      cause: { type: "a", id: "t2" },
    });
    expect(event.from).toBe("pending");
  });

  it("records a rejection without advancing the sequence", async () => {
    const instance = make();
    await commit(instance, {
      state: "approved",
      values: {},
      at: 2000,
      cause: { type: "a", id: "t2" },
    });
    instance.reject({
      code: "UNKNOWN_STATE",
      reason: "no handler",
      at: 3000,
      cause: { type: "x", id: "t3" },
    });

    expect(instance.seq).toBe(1);
    expect(instance.events).toHaveLength(3);
    expect(instance.events[2]).toMatchObject({
      type: "rejected",
      seq: 1,
      code: "UNKNOWN_STATE",
    });
  });

  it("keeps seq non-decreasing across a stream that mixes commits and rejections", async () => {
    const instance = make();
    instance.reject({
      code: "UNKNOWN_TRIGGER",
      reason: "x",
      at: 1,
      cause: { type: "x", id: "t2" },
    });
    await commit(instance, {
      state: "approved",
      values: {},
      at: 2,
      cause: { type: "a", id: "t3" },
    });
    instance.reject({
      code: "UNKNOWN_STATE",
      reason: "y",
      at: 3,
      cause: { type: "y", id: "t4" },
    });

    const seqs = instance.events.map((e) => e.seq);
    expect(seqs).toEqual([0, 0, 1, 1]);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("leaves only transition events for replay", async () => {
    const instance = make();
    await commit(instance, {
      state: "approved",
      values: {},
      at: 2,
      cause: { type: "a", id: "t2" },
    });
    instance.reject({
      code: "UNKNOWN_STATE",
      reason: "y",
      at: 3,
      cause: { type: "y", id: "t3" },
    });

    const replayed = instance.events.filter(isTransitionEvent);
    expect(replayed.at(-1)?.to).toBe("approved");
  });

  it("is idle only while its inbox has nothing running and nothing waiting", async () => {
    const instance = make();
    expect(instance.idle).toBe(true);

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const settled = instance.inbox.enqueue(
      { type: "go", id: "t1" },
      async () => {
        await held;
        return commit(instance, {
          state: "approved",
          values: {},
          at: 2000,
          cause: { type: "go", id: "t1" },
        }) as never;
      }
    );

    // Eviction must not touch an instance with work in flight.
    expect(instance.idle).toBe(false);

    release();
    await settled;
    expect(instance.idle).toBe(true);
  });
});

describe("sealValues", () => {
  it("copies, so a later mutation of the source cannot reach committed state", () => {
    const source = { by: "amy", nested: { deep: 1 } };
    const sealed = sealValues(source, "orders:1");

    source.by = "mallory";
    source.nested.deep = 99;

    expect(sealed).toEqual({ by: "amy", nested: { deep: 1 } });
  });

  it("freezes the result", () => {
    expect(Object.isFrozen(sealValues({ a: 1 }, "orders:1"))).toBe(true);
  });

  it("refuses values that cannot be serialized, naming the key", () => {
    try {
      sealValues({ fn: () => 1 }, "orders:1");
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EkmanError);
      expect((err as EkmanError).code).toBe("HANDLER_FAILED");
      expect((err as EkmanError).key).toBe("orders:1");
    }
  });
});

describe("sealing values", () => {
  it("freezes nested objects and arrays", () => {
    const sealed = sealValues({ nested: { deep: [{ n: 1 }] } }, "orders:1");

    expect(Object.isFrozen(sealed.nested)).toBe(true);
    expect(Object.isFrozen(sealed.nested.deep)).toBe(true);
    expect(Object.isFrozen(sealed.nested.deep[0])).toBe(true);
  });

  it("leaves binary data usable", () => {
    const sealed = sealValues({ blob: new Uint8Array([1, 2, 3]) }, "orders:1");

    expect(sealed.blob.byteLength).toBe(3);
  });

  it("copies a value that refers to itself", () => {
    const loop: { self?: unknown } = {};
    loop.self = loop;

    const sealed = sealValues({ loop }, "orders:1");

    expect(sealed.loop.self).toBe(sealed.loop);
  });

  it("freezes below an object that was already frozen at the top", () => {
    const loaded = Object.freeze({ nested: { deeper: { n: 1 } } });

    freezeValues(loaded);

    expect(Object.isFrozen(loaded.nested)).toBe(true);
    expect(Object.isFrozen(loaded.nested.deeper)).toBe(true);
  });

  it("freezes in place what a store handed back", () => {
    const loaded = { nested: { n: 1 } };

    expect(freezeValues(loaded)).toBe(loaded);
    expect(Object.isFrozen(loaded.nested)).toBe(true);
  });
});

describe("a commit whose values cannot be measured", () => {
  it("is refused before anything is written or applied", async () => {
    const store = memoryStore();
    const record = new InstanceRecord({
      key: "orders:1",
      entity: "orders",
      initial: "pending",
      initialValues: {},
      states: STATES,
      at: 0,
      cause: { type: "init", id: "t1" },
      deps: testDeps({ store }),
    });
    await record.ready();

    const refused = await commit(record, {
      state: "pending",
      values: { big: 10n },
      at: 1,
      cause: { type: "x", id: "t2" },
    }).catch((error: EkmanError) => error);

    expect(refused).toMatchObject({ code: "HANDLER_FAILED", key: "orders:1" });
    expect(record.seq).toBe(0);
    expect(await store.read("orders:1")).toHaveLength(1);
  });
});

describe("telling the runtime about a commit", () => {
  it("reports every applied commit, and whether it moved the instance", async () => {
    const reported: [string, boolean][] = [];
    const record = new InstanceRecord({
      key: "orders:1",
      entity: "orders",
      initial: "pending",
      initialValues: {},
      states: STATES,
      at: 0,
      cause: { type: "init", id: "t1" },
      deps: testDeps({
        committed: (committed, moved) => reported.push([committed.key, moved]),
      }),
    });

    await commit(record, {
      state: "pending",
      values: {},
      at: 1,
      cause: { type: "x", id: "t2" },
    });
    await commit(record as InstanceRecord<string, Record<string, unknown>>, {
      state: "approved",
      values: {},
      at: 2,
      cause: { type: "x", id: "t3" },
    });

    expect(reported).toEqual([
      ["orders:1", false],
      ["orders:1", true],
    ]);
  });
});

describe("what a record retains of its own history", () => {
  const record = (store?: ReturnType<typeof memoryStore>) =>
    new InstanceRecord<string, Record<string, unknown>>({
      key: "orders:1",
      entity: "orders",
      initial: "pending",
      initialValues: Object.freeze({}),
      states: STATES,
      at: 0,
      cause: { type: "init", id: "t1" },
      deps: testDeps(store === undefined ? {} : { store }),
    });

  const commits = async (
    instance: InstanceRecord<string, Record<string, unknown>>,
    count: number
  ) => {
    for (let n = 1; n <= count; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: commits to one key are sequential
      await commit(instance, {
        state: "pending",
        values: { n },
        at: n,
        cause: { type: "x", id: `c${n}` },
      });
    }
  };

  it("keeps the whole stream when nothing else holds it", async () => {
    const instance = record();
    await commits(instance, 3);
    instance.reject({
      code: "UNKNOWN_TRIGGER",
      reason: "no",
      at: 4,
      cause: { type: "y", id: "c4" },
    });

    expect(instance.events.map((event) => event.type)).toEqual([
      "transition",
      "transition",
      "transition",
      "transition",
      "rejected",
    ]);
    expect(instance.historyTrimmed).toBe(false);
  });

  it("keeps nothing the store already holds", async () => {
    const store = memoryStore();
    const instance = record(store);
    await instance.ready();
    await commits(instance, 3);

    expect(instance.events).toEqual([]);
    expect(await store.read("orders:1")).toHaveLength(4);
  });

  it("keeps the restores a store cannot hold, and knows the latest", async () => {
    const store = memoryStore();
    const first = record(store);
    await first.ready();
    await commits(first, 2);
    expect(first.lastRestored).toBeUndefined();

    const second = record(store);
    await second.ready();
    await commits(second, 1);

    expect(second.events.map((event) => event.type)).toEqual(["restored"]);
    expect(second.lastRestored).toBe(second.events[0]);
  });

  it("keeps only the most recent events once there are too many", async () => {
    const instance = record();
    await commits(instance, RESIDENT_HISTORY_LIMIT + 5);

    expect(instance.events).toHaveLength(RESIDENT_HISTORY_LIMIT);
    expect(instance.events.at(-1)).toMatchObject({
      seq: RESIDENT_HISTORY_LIMIT + 5,
    });
    expect(instance.events[0]).toMatchObject({ seq: 6 });
    expect(instance.historyTrimmed).toBe(true);
  });

  it("holds a bounded number however long the key lives", async () => {
    const instance = record();
    await commits(instance, RESIDENT_HISTORY_LIMIT * 3);

    expect(instance.events).toHaveLength(RESIDENT_HISTORY_LIMIT);
    expect(instance.events.at(-1)).toMatchObject({
      seq: RESIDENT_HISTORY_LIMIT * 3,
    });
  });
});

describe("sealing plain data without a structured clone", () => {
  it("copies and freezes plain objects and arrays", () => {
    const source = {
      list: [1, { deep: true }],
      empty: undefined,
      nan: Number.NaN,
    };
    const sealed = sealValues(source, "orders:1");

    expect(sealed).toEqual(source);
    expect(sealed).not.toBe(source);
    expect(sealed.list).not.toBe(source.list);
    expect(Object.isFrozen(sealed.list[1])).toBe(true);
    expect("empty" in sealed).toBe(true);
  });

  it("keeps the holes in a sparse array", () => {
    const sparse: unknown[] = [];
    sparse[2] = "x";
    const sealed = sealValues({ sparse }, "orders:1");

    expect(sealed.sparse).toHaveLength(3);
    expect(0 in sealed.sparse).toBe(false);
  });

  it("still copies what plain copying cannot express", () => {
    const when = new Date(0);
    const sealed = sealValues(
      { when, tags: new Map([["a", 1]]), nested: { when } },
      "orders:1"
    );

    expect(sealed.when).toEqual(when);
    expect(sealed.when).not.toBe(when);
    expect(sealed.tags.get("a")).toBe(1);
    expect(sealed.nested.when).toBeInstanceOf(Date);
  });

  it("does not let a key named __proto__ replace the prototype", () => {
    const source = JSON.parse('{"__proto__": {"polluted": true}}');
    const sealed = sealValues(source, "orders:1") as Record<string, unknown>;

    expect(Object.getPrototypeOf(sealed)).toBe(Object.prototype);
    expect(Object.keys(sealed)).toEqual(["__proto__"]);
  });

  it("copies data nested deeper than it is willing to walk", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 200; depth += 1) {
      deep = { deep };
    }

    expect(sealValues({ deep }, "orders:1")).toEqual({ deep });
  });
});

describe("sealing values that share structure", () => {
  it("does not copy a shared object once for every path that reaches it", () => {
    let node: Record<string, unknown> = { leaf: 1 };
    for (let depth = 0; depth < 24; depth += 1) {
      node = { left: node, right: node };
    }

    const started = performance.now();
    const sealed = sealValues({ node }, "orders:1");

    expect(performance.now() - started).toBeLessThan(250);
    expect(Object.isFrozen(sealed.node)).toBe(true);
    expect((sealed.node.left as { left: unknown }).left).toBeDefined();
  });
});

describe("reloading after another writer moved the key", () => {
  const record = (store: ReturnType<typeof memoryStore>) =>
    new InstanceRecord<string, Record<string, unknown>>({
      key: "orders:1",
      entity: "orders",
      initial: "pending",
      initialValues: Object.freeze({}),
      states: STATES,
      at: 0,
      cause: { type: "init", id: "t1" },
      deps: testDeps({ store }),
    });

  const move = (
    instance: InstanceRecord<string, Record<string, unknown>>,
    state: string,
    at: number
  ) =>
    commit(instance, {
      state,
      values: {},
      at,
      cause: { type: "x", id: `c${at}` },
    });

  /** Record that a bound has said what it had to say, the way a sweep under `warn` does. */
  const said = (
    instance: InstanceRecord<string, Record<string, unknown>>,
    kind: "temporal" | "stale",
    name: string
  ) =>
    instance.violation({
      violation: { kind, name, policy: "warn", reason: "over its bound" },
      at: 1,
      cause: { type: `constraint.${kind}`, id: `v-${name}` },
    });

  const overtaken = async (
    others: (
      other: InstanceRecord<string, Record<string, unknown>>
    ) => Promise<unknown>
  ) => {
    const store = memoryStore();
    const mine = record(store);
    await mine.ready();
    said(mine, "temporal", "too-slow");
    said(mine, "stale", "gone-quiet");
    await mine.flushed();

    const theirs = record(store);
    await theirs.ready();
    await others(theirs);

    await move(mine, "pending", 99).catch(() => undefined);
    await mine.ready();
    return mine;
  };

  it("re-arms its bounds when the reload finds a new entry into the state", async () => {
    const mine = await overtaken(async (theirs) => {
      await move(theirs, "approved", 5);
      await move(theirs, "pending", 6);
    });

    expect(mine.state).toBe("pending");
    expect(mine.hasFired("too-slow")).toBe(false);
    expect(mine.hasFired("gone-quiet")).toBe(false);
  });

  it("keeps a time-in-state bound when the other writer only changed values", async () => {
    const mine = await overtaken((theirs) => move(theirs, "pending", 5));

    expect(mine.hasFired("too-slow")).toBe(true);
  });

  it("arms a freshness bound again when the other writer only changed values", async () => {
    // The instance was heard from, by a commit this record did not make. What its
    // freshness bound said here was about a silence that commit ended.
    const mine = await overtaken((theirs) => move(theirs, "pending", 5));

    expect(mine.seq).toBe(1);
    expect(mine.hasFired("gone-quiet")).toBe(false);
  });

  it("keeps a freshness bound said when the other writer's commit was the answer to it", async () => {
    const store = memoryStore();
    const mine = record(store);
    await mine.ready();
    const asked = { type: "constraint.stale", id: "t9" };
    mine.violation({
      violation: {
        kind: "stale",
        name: "gone-quiet",
        policy: "reject",
        reason: "over its bound",
      },
      at: 1,
      cause: asked,
    });
    await mine.flushed();

    const theirs = record(store);
    await theirs.ready();
    await commit(theirs, { state: "pending", values: {}, at: 5, cause: asked });

    await move(mine, "pending", 99).catch(() => undefined);
    await mine.ready();

    expect(mine.hasFired("gone-quiet")).toBe(true);
    expect(mine.undelivered("gone-quiet")).toBeUndefined();
  });
});
