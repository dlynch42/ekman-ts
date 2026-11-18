import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { TemporalTrigger } from "../src/constraints";
import { DEFAULT_TEMPORAL_TRIGGER } from "../src/constraints";
import { Ekman } from "../src/ekman";
import { defineEntity } from "../src/entity";
import { EkmanError } from "../src/errors";
import type { EkmanEvent, TransitionEvent } from "../src/events";
import { RESIDENT_HISTORY_LIMIT } from "../src/instance";
import { fail, stay, transitionTo } from "../src/results";
import type { Store } from "../src/store";
import { memoryStore } from "../src/stores/memory";
import type { TelemetryEvent } from "../src/telemetry";
import { frozenClock } from "./deps";

const NON_NEGATIVE_INTEGER = /non-negative integer/;
const NOT_BUILT = /was not built by defineEntity/;
const NOTHING_TO_COMPACT = /no configured store layer can compact/;
const POSITIVE_MILLISECONDS = /positive number of milliseconds/;

/** A clock that advances a fixed step per read, so `at` is assertable. */
const steppingClock = (start = 1000, step = 1000) => {
  let t = start - step;
  return () => {
    t += step;
    return t;
  };
};

const orders = defineEntity("orders", {
  initial: "pending",
  states: {
    pending: (_order, trigger) =>
      trigger.type === "approve"
        ? transitionTo("approved", { by: trigger.actor as string })
        : fail(new Error(`cannot ${trigger.type} while pending`)),
    approved: (order) => stay({ ...order.values, seen: true }),
  },
});

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return (err as EkmanError).code;
  }
  throw new Error("expected a rejection");
};

const transitions = (events: readonly EkmanEvent[]) =>
  events.filter((e): e is TransitionEvent => e.type === "transition");

describe("registration", () => {
  it("exposes a handle per constructor entity", () => {
    const ekman = new Ekman({ entities: [orders] });
    expect(ekman.entities.orders.name).toBe("orders");
    expect(ekman.entityNames).toEqual(["orders"]);
  });

  it("starts empty when given no entities", () => {
    expect(new Ekman().entityNames).toEqual([]);
  });

  it("registers after construction and returns a handle", () => {
    const ekman = new Ekman();
    const handle = ekman.define(orders);
    expect(handle.name).toBe("orders");
    expect(ekman.entityNames).toEqual(["orders"]);
  });

  it("refuses a duplicate entity name", () => {
    const ekman = new Ekman({ entities: [orders] });
    expect(() => ekman.define(orders)).toThrow(EkmanError);
    try {
      ekman.define(orders);
    } catch (err) {
      expect((err as EkmanError).code).toBe("DUPLICATE_ENTITY");
    }
  });

  it("lets one definition serve two runtimes, which is what keeps it runtime-free", () => {
    const a = new Ekman({ entities: [orders] });
    const b = new Ekman({ entities: [orders] });
    expect(a.entities.orders.name).toBe(b.entities.orders.name);
  });
});

describe("addressing", () => {
  it("rejects a malformed key", async () => {
    const ekman = new Ekman({ entities: [orders] });
    expect(await code(ekman.send("orders:bad key", { type: "approve" }))).toBe(
      "INVALID_KEY"
    );
    expect(await code(ekman.send("orders", { type: "approve" }))).toBe(
      "INVALID_KEY"
    );
  });

  it("rejects a key whose first segment names no entity", async () => {
    const ekman = new Ekman({ entities: [orders] });
    expect(await code(ekman.send("invoices:1", { type: "approve" }))).toBe(
      "UNKNOWN_ENTITY"
    );
  });

  it("refuses an unregistered entity before any store is asked about it", async () => {
    const ekman = new Ekman({ entities: [orders] });

    expect(await code(ekman.history("invoices:1"))).toBe("UNKNOWN_ENTITY");
    expect(await code(ekman.forget("invoices:1"))).toBe("UNKNOWN_ENTITY");
    expect(await code(ekman.query({ entity: "invoices" }))).toBe(
      "UNKNOWN_ENTITY"
    );
  });

  it("names the key that asked, or the query when no key did", async () => {
    const ekman = new Ekman({ entities: [orders] });

    const byKey = await ekman.history("invoices:1").catch((err) => err);
    expect(byKey.key).toBe("invoices:1");
    expect(byKey.message).toContain('key "invoices:1" names entity "invoices"');

    const byQuery = await ekman.query({ entity: "invoices" }).catch((e) => e);
    expect(byQuery.key).toBeUndefined();
    expect(byQuery.message).toContain('the query names entity "invoices"');
    expect(byQuery.message).toContain("Registered: orders");
  });

  it("never throws synchronously, so every caller can rely on catch", () => {
    const ekman = new Ekman({ entities: [orders] });
    const promise = ekman.send("nope", { type: "approve" });
    expect(promise).toBeInstanceOf(Promise);
    return expect(promise).rejects.toThrow(EkmanError);
  });

  it("builds keys through the handle", async () => {
    const ekman = new Ekman({ entities: [orders] });
    expect(ekman.entities.orders.key("abc")).toBe("orders:abc");
    const result = await ekman.entities.orders.send("abc", {
      type: "approve",
      actor: "amy",
    });
    expect(result.key).toBe("orders:abc");
  });

  it("rejects a trigger with no type", async () => {
    const ekman = new Ekman({ entities: [orders] });
    expect(await code(ekman.send("orders:1", {} as { type: string }))).toBe(
      "UNKNOWN_TRIGGER"
    );
  });
});

describe("initialization", () => {
  it("starts an instance in the declared initial state with empty values", async () => {
    const ekman = new Ekman({ entities: [orders] });
    await ekman.send("orders:1", { type: "approve", actor: "amy" });

    const [init] = transitions((await ekman.history("orders:1")).events);
    expect(init).toMatchObject({
      from: null,
      to: "pending",
      seq: 0,
      values: {},
    });
  });

  it("records initialization as the one event whose from is null", async () => {
    const ekman = new Ekman({ entities: [orders] });
    await ekman.send("orders:1", { type: "approve", actor: "amy" });

    const nullFrom = transitions(
      (await ekman.history("orders:1")).events
    ).filter((e) => e.from === null);
    expect(nullFrom).toHaveLength(1);
  });

  it("starts from declared initial values", async () => {
    const withValues = defineEntity("carts", {
      initial: "open",
      values: { total: 0, currency: "usd" },
      states: {
        open: (cart) => stay({ ...cart.values, total: cart.values.total + 1 }),
      },
    });
    const ekman = new Ekman({ entities: [withValues] });
    const result = await ekman.entities.carts.send("1", { type: "add" });
    expect(result.values).toEqual({ total: 1, currency: "usd" });
  });

  it("reports nothing for a key never addressed", async () => {
    const ekman = new Ekman({ entities: [orders] });
    expect(ekman.inspect("orders:never")).toBeUndefined();
    expect((await ekman.history("orders:never")).events).toEqual([]);
    expect(ekman.residentKeys).toEqual([]);
  });
});

describe("handler results", () => {
  it("commits a transitionTo", async () => {
    const ekman = new Ekman({ entities: [orders] });
    const result = await ekman.send("orders:1", {
      type: "approve",
      actor: "amy",
    });

    expect(result).toMatchObject({
      key: "orders:1",
      state: "approved",
      values: { by: "amy" },
      seq: 1,
    });
    expect(ekman.inspect("orders:1")).toMatchObject({
      state: "approved",
      seq: 1,
    });
  });

  it("commits a stay without changing state", async () => {
    const ekman = new Ekman({ entities: [orders] });
    await ekman.send("orders:1", { type: "approve", actor: "amy" });
    const result = await ekman.send("orders:1", { type: "look" });

    expect(result).toMatchObject({
      state: "approved",
      seq: 2,
      values: { by: "amy", seen: true },
    });
  });

  it("leaves the instance untouched on fail", async () => {
    const ekman = new Ekman({ entities: [orders] });
    expect(await code(ekman.send("orders:1", { type: "cancel" }))).toBe(
      "HANDLER_FAILED"
    );

    expect(ekman.inspect("orders:1")).toMatchObject({
      state: "pending",
      seq: 0,
      values: {},
    });
    expect(transitions((await ekman.history("orders:1")).events)).toHaveLength(
      1
    );
  });

  it("treats a thrown error as fail", async () => {
    const thrower = defineEntity("thrower", {
      initial: "a",
      states: {
        a: () => {
          throw new RangeError("boom");
        },
      },
    });
    const ekman = new Ekman({ entities: [thrower] });

    expect(await code(ekman.send("thrower:1", { type: "go" }))).toBe(
      "HANDLER_FAILED"
    );
    expect(ekman.inspect("thrower:1")).toMatchObject({ state: "a", seq: 0 });
  });

  it("treats a handler that returns a non-result as fail", async () => {
    const wrong = defineEntity("wrong", {
      initial: "a",
      states: { a: () => "approved" as unknown as ReturnType<typeof stay> },
    });
    const ekman = new Ekman({ entities: [wrong] });
    expect(await code(ekman.send("wrong:1", { type: "go" }))).toBe(
      "HANDLER_FAILED"
    );
  });

  it("carries values forward when a result omits them", async () => {
    const carry = defineEntity("carry", {
      initial: "a",
      values: { keep: "me" },
      states: { a: () => transitionTo("b"), b: () => stay() },
    });
    const ekman = new Ekman({ entities: [carry] });

    const moved = await ekman.entities.carry.send("1", { type: "go" });
    expect(moved).toMatchObject({ state: "b", values: { keep: "me" } });

    const stayed = await ekman.entities.carry.send("1", { type: "go" });
    expect(stayed.values).toEqual({ keep: "me" });
  });
});

describe("error handlers", () => {
  it("can turn a failure into a committed transition", async () => {
    const recovering = defineEntity("recovering", {
      initial: "a",
      states: {
        a: () => fail(new RangeError("boom")),
        failed: () => stay(),
      },
      onError: {
        RangeError: (instance) =>
          transitionTo("failed", { ...instance.values }),
      },
    });
    const ekman = new Ekman({ entities: [recovering] });

    const result = await ekman.entities.recovering.send("1", { type: "go" });
    expect(result).toMatchObject({ state: "failed", seq: 1 });
  });

  it("still rejects when the error handler itself throws", async () => {
    const worse = defineEntity("worse", {
      initial: "a",
      states: { a: () => fail(new Error("boom")) },
      onError: {
        "*": () => {
          throw new Error("handler blew up");
        },
      },
    });
    const ekman = new Ekman({ entities: [worse] });

    expect(await code(ekman.entities.worse.send("1", { type: "go" }))).toBe(
      "HANDLER_FAILED"
    );
    // The original failure is the one reported; the instance never moved.
    expect(ekman.entities.worse.inspect("1")).toMatchObject({
      state: "a",
      seq: 0,
    });
  });

  it("still rejects when the error handler also fails", async () => {
    const stubborn = defineEntity("stubborn", {
      initial: "a",
      states: { a: () => fail(new Error("boom")) },
      onError: { "*": () => fail(new Error("also boom")) },
    });
    const ekman = new Ekman({ entities: [stubborn] });

    expect(await code(ekman.entities.stubborn.send("1", { type: "go" }))).toBe(
      "HANDLER_FAILED"
    );
    expect(ekman.entities.stubborn.inspect("1")).toMatchObject({
      state: "a",
      seq: 0,
    });
  });
});

describe("unknown policy", () => {
  it("refuses a trigger in a state with no handler, and records it", async () => {
    const dead = defineEntity("dead", {
      initial: "a",
      states: { a: () => transitionTo("b" as "a") },
    });
    const ekman = new Ekman({ entities: [dead] });

    await ekman.send("dead:1", { type: "go" });
    expect(await code(ekman.send("dead:1", { type: "go" }))).toBe(
      "UNKNOWN_STATE"
    );

    const rejected = (await ekman.history("dead:1")).events.filter(
      (e) => e.type === "rejected"
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ code: "UNKNOWN_STATE", seq: 1 });
  });

  it("refuses an undeclared trigger type when a trigger list is declared", async () => {
    const strict = defineEntity("strict", {
      initial: "a",
      triggers: ["go"],
      states: { a: () => stay() },
    });
    const ekman = new Ekman({ entities: [strict] });

    await ekman.send("strict:1", { type: "go" });
    expect(await code(ekman.send("strict:1", { type: "sneak" }))).toBe(
      "UNKNOWN_TRIGGER"
    );

    const rejected = (await ekman.history("strict:1")).events.filter(
      (e) => e.type === "rejected"
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ code: "UNKNOWN_TRIGGER" });
  });

  it("accepts any trigger type when none are declared", async () => {
    const ekman = new Ekman({ entities: [orders] });
    await expect(
      ekman.send("orders:1", { type: "approve", actor: "amy" })
    ).resolves.toBeDefined();
  });

  it("does not advance the sequence on a refusal", async () => {
    const strict = defineEntity("strict", {
      initial: "a",
      triggers: ["go"],
      states: { a: () => stay() },
    });
    const ekman = new Ekman({ entities: [strict] });

    await code(ekman.send("strict:1", { type: "sneak" }));
    expect(ekman.inspect("strict:1")).toMatchObject({ seq: 0 });
  });
});

describe("sequence and events", () => {
  it("advances the sequence exactly once per commit, with no gaps", async () => {
    const counter = defineEntity("counter", {
      initial: "a",
      states: { a: () => stay() },
    });
    const ekman = new Ekman({ entities: [counter] });

    for (let i = 0; i < 5; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each commit must see the sequence the one before it left behind
      await ekman.send("counter:1", { type: "tick" });
    }

    expect(
      transitions((await ekman.history("counter:1")).events).map((e) => e.seq)
    ).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("records the trigger as the cause, with a deterministic id", async () => {
    const ekman = new Ekman({ entities: [orders], now: steppingClock() });
    await ekman.send("orders:1", { type: "approve", actor: "amy" });

    const [init, approved] = transitions(
      (await ekman.history("orders:1")).events
    );
    expect(init?.cause).toEqual({ type: "init", id: "t1" });
    expect(approved?.cause).toEqual({ type: "approve", id: "t1" });
  });

  it("honours a caller-supplied trigger id", async () => {
    const ekman = new Ekman({ entities: [orders] });
    await ekman.send("orders:1", {
      type: "approve",
      actor: "amy",
      id: "msg-991",
    });
    expect(
      transitions((await ekman.history("orders:1")).events)[1]?.cause.id
    ).toBe("msg-991");
  });

  it("stamps events from the injected clock", async () => {
    const ekman = new Ekman({
      entities: [orders],
      now: steppingClock(1000, 1000),
    });
    await ekman.send("orders:1", { type: "approve", actor: "amy" });

    expect(
      transitions((await ekman.history("orders:1")).events).map((e) => e.at)
    ).toEqual([1000, 2000]);
  });

  it("freezes committed values so a handler cannot mutate them afterwards", async () => {
    const leaky: { by: string } = { by: "amy" };
    const entity = defineEntity("leaky", {
      initial: "a",
      states: { a: () => transitionTo("a", leaky) },
    });
    const ekman = new Ekman({ entities: [entity] });

    await ekman.entities.leaky.send("1", { type: "go" });
    leaky.by = "mallory";

    expect(ekman.entities.leaky.inspect("1")?.values).toEqual({ by: "amy" });
  });

  it("refuses values that are not serializable", async () => {
    const bad = defineEntity("bad", {
      initial: "a",
      states: { a: () => stay({ fn: () => 1 }) },
    });
    const ekman = new Ekman({ entities: [bad] });
    expect(await code(ekman.entities.bad.send("1", { type: "go" }))).toBe(
      "HANDLER_FAILED"
    );
  });
});

describe("per-key serialization", () => {
  it("runs one handler at a time per key", async () => {
    let active = 0;
    let maxActive = 0;
    const slow = defineEntity("slow", {
      initial: "a",
      states: {
        a: async (instance) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return stay({
            n: ((instance.values.n as number | undefined) ?? 0) + 1,
          });
        },
      },
    });
    const ekman = new Ekman({ entities: [slow] });

    await Promise.all([
      ekman.entities.slow.send("1", { type: "go" }),
      ekman.entities.slow.send("1", { type: "go" }),
      ekman.entities.slow.send("1", { type: "go" }),
    ]);

    expect(maxActive).toBe(1);
    expect(ekman.entities.slow.inspect("1")).toMatchObject({
      seq: 3,
      values: { n: 3 },
    });
  });

  it("gives each trigger the state the previous one committed", async () => {
    const observed: number[] = [];
    const chain = defineEntity("chain", {
      initial: "a",
      values: { n: 0 },
      states: {
        a: async (instance) => {
          observed.push(instance.values.n);
          await new Promise((resolve) => setTimeout(resolve, 1));
          return stay({ n: instance.values.n + 1 });
        },
      },
    });
    const ekman = new Ekman({ entities: [chain] });

    await Promise.all([
      ekman.entities.chain.send("1", { type: "go" }),
      ekman.entities.chain.send("1", { type: "go" }),
      ekman.entities.chain.send("1", { type: "go" }),
    ]);

    expect(observed).toEqual([0, 1, 2]);
  });

  it("dispatches against the state at dequeue, not the state at enqueue", async () => {
    const seen: string[] = [];
    const moving = defineEntity("moving", {
      initial: "first",
      states: {
        first: async () => {
          seen.push("first");
          await new Promise((resolve) => setTimeout(resolve, 5));
          return transitionTo("second");
        },
        second: () => {
          seen.push("second");
          return stay();
        },
      },
    });
    const ekman = new Ekman({ entities: [moving] });

    // Both are enqueued while the instance is in "first". The second must still run
    // the "second" handler, because dispatch resolves at dequeue time.
    const a = ekman.entities.moving.send("1", { type: "go" });
    const b = ekman.entities.moving.send("1", { type: "go" });
    await Promise.all([a, b]);

    expect(seen).toEqual(["first", "second"]);
  });

  it("does not let one key block another", async () => {
    const order: string[] = [];
    const mixed = defineEntity("mixed", {
      initial: "a",
      states: {
        a: async (instance) => {
          const delay = instance.key.endsWith("slow") ? 20 : 0;
          await new Promise((resolve) => setTimeout(resolve, delay));
          order.push(instance.key);
          return stay();
        },
      },
    });
    const ekman = new Ekman({ entities: [mixed] });

    await Promise.all([
      ekman.entities.mixed.send("slow", { type: "go" }),
      ekman.entities.mixed.send("fast", { type: "go" }),
    ]);

    expect(order).toEqual(["mixed:fast", "mixed:slow"]);
  });

  it("keeps the queue alive after a failed trigger", async () => {
    const flaky = defineEntity("flaky", {
      initial: "a",
      states: {
        a: (instance, trigger) =>
          trigger.type === "bad"
            ? fail(new Error("boom"))
            : stay({ ok: true, ...instance.values }),
      },
    });
    const ekman = new Ekman({ entities: [flaky] });

    const bad = ekman.entities.flaky.send("1", { type: "bad" });
    const good = ekman.entities.flaky.send("1", { type: "good" });

    expect(await code(bad)).toBe("HANDLER_FAILED");
    await expect(good).resolves.toMatchObject({ seq: 1, values: { ok: true } });
  });
});

describe("post", () => {
  it("delivers without awaiting", async () => {
    const ekman = new Ekman({ entities: [orders] });
    ekman.entities.orders.post("1", { type: "approve", actor: "amy" });

    await vi.waitFor(() => {
      expect(ekman.entities.orders.inspect("1")).toMatchObject({
        state: "approved",
      });
    });
  });

  it("routes a failure to onUnhandled rather than dropping it", async () => {
    const onUnhandled = vi.fn();
    const ekman = new Ekman({ entities: [orders], onUnhandled });
    ekman.entities.orders.post("1", { type: "cancel" });

    await vi.waitFor(() => expect(onUnhandled).toHaveBeenCalledTimes(1));
    const [reported, context] = onUnhandled.mock.calls[0] ?? [];
    expect((reported as EkmanError).code).toBe("HANDLER_FAILED");
    expect(context).toEqual({ source: "post", key: "orders:1" });
  });

  it("says an escalation that was refused came from an escalation", async () => {
    let now = 1000;
    const onUnhandled = vi.fn();
    const stuck = defineEntity("stuck", {
      initial: "waiting",
      states: {
        waiting: (_instance, trigger) => {
          if (trigger.type === DEFAULT_TEMPORAL_TRIGGER) {
            throw new Error("cannot escalate");
          }
          return stay();
        },
      },
      constraints: { temporal: [{ in: "waiting", within: 50 }] },
    });
    const ekman = new Ekman({
      entities: [stuck],
      now: () => now,
      onUnhandled,
    });
    await ekman.entities.stuck.send("a", { type: "arrive" });

    now += 100;
    await ekman.sweep();

    const [reported, context] = onUnhandled.mock.calls[0] ?? [];
    expect((reported as EkmanError).code).toBe("HANDLER_FAILED");
    expect(context).toEqual({ source: "escalation", key: "stuck:a" });
  });
});

describe("a definition the runtime did not build", () => {
  it("is refused at registration, not on the first trigger", () => {
    // Compiles, because the public graph type is a shape. It is not what the runtime needs.
    const forged = {
      ...orders,
      states: { ...orders.states, names: ["pending"] },
    } as typeof orders;

    expect(() => new Ekman({ entities: [forged] })).toThrow(NOT_BUILT);
    expect(() => new Ekman().define(forged)).toThrow(NOT_BUILT);
  });
});

describe("telemetry", () => {
  it("reports the inbox and the handler without touching the event stream", async () => {
    const seen: TelemetryEvent[] = [];
    const ekman = new Ekman({
      entities: [orders],
      telemetry: { "*": (event) => seen.push(event) },
    });

    await ekman.entities.orders.send("1", { type: "approve", actor: "amy" });

    expect(seen.map((event) => event.type)).toEqual([
      "inbox.enqueued",
      "handler.started",
      "handler.settled",
      // Accounting closes every commit, because that is where the number changes and
      // where the values needed to measure it have just been serialized.
      "memory.accounted",
    ]);
    expect(seen.at(-1)).toMatchObject({
      key: "orders:1",
      entity: "orders",
      residentCount: 1,
      maxBytes: null,
      overBudget: false,
    });

    // Runtime metadata stays out of the domain stream.
    const { events } = await ekman.entities.orders.history("1");
    for (const event of events) {
      expect(event).not.toHaveProperty("durationMs");
      expect(event).not.toHaveProperty("depth");
    }
  });

  it("classifies a refused trigger separately from a failed handler", async () => {
    // A trigger that never reaches a handler was refused; one the handler rejected
    // failed. Collapsing the two would hide a misrouted producer inside an error rate.
    const strict = defineEntity("strict", {
      initial: "pending",
      triggers: ["approve"],
      states: { pending: () => fail(new Error("nope")) },
    });

    const seen: TelemetryEvent[] = [];
    const ekman = new Ekman({
      entities: [strict],
      telemetry: { "handler.settled": (event) => seen.push(event) },
    });

    await expect(
      ekman.entities.strict.send("1", { type: "approve" })
    ).rejects.toThrow();
    await expect(
      ekman.send("strict:2", { type: "unrecognized" })
    ).rejects.toThrow();

    expect(
      seen.map((event) => event.type === "handler.settled" && event.outcome)
    ).toEqual(["failed", "refused"]);
  });

  it("keeps a throwing telemetry sink from breaking the dispatch it observes", async () => {
    const onUnhandled = vi.fn();
    const ekman = new Ekman({
      entities: [orders],
      onUnhandled,
      // Throws for every event, which covers both the inbox's emissions and the
      // runtime's own.
      telemetry: {
        "*": () => {
          throw new Error("sink exploded");
        },
      },
    });

    await expect(
      ekman.entities.orders.send("1", { type: "approve", actor: "amy" })
    ).resolves.toMatchObject({ state: "approved" });

    // inbox.enqueued, handler.started, handler.settled, memory.accounted: each reported,
    // none fatal.
    expect(onUnhandled).toHaveBeenCalledTimes(4);
    expect(onUnhandled.mock.calls.map(([, context]) => context)).toEqual(
      new Array(4).fill({ source: "telemetry", key: "orders:1" })
    );
  });

  it("refuses an inbox configuration it cannot satisfy, at construction", () => {
    expect(() => new Ekman({ inbox: { capacity: -1 } })).toThrow(
      NON_NEGATIVE_INTEGER
    );
  });
});

describe("typing", () => {
  it("types the handle map from the constructor entities", () => {
    const ekman = new Ekman({ entities: [orders] });
    expectTypeOf(ekman.entities.orders.name).toEqualTypeOf<string>();
    expectTypeOf(ekman.entities).toHaveProperty("orders");
  });
});

describe("uncovered surface", () => {
  it("reads history through the handle", async () => {
    const ekman = new Ekman({ entities: [orders] });
    await ekman.entities.orders.send("1", { type: "approve", actor: "amy" });

    expect(await ekman.entities.orders.history("1")).toEqual(
      await ekman.history("orders:1")
    );

    const history = await ekman.entities.orders.history("1");
    expect(history.events).toHaveLength(2);
    // Memory-only, so the answer covers what this runtime retains and says so rather than
    // presenting it as the whole story.
    expect(history.complete).toBe(false);
    expect(history.reasons).toEqual(["no-durable-store"]);
  });

  it("reads a snapshot through the handle", async () => {
    const ekman = new Ekman({ entities: [orders] });
    await ekman.entities.orders.send("1", { type: "approve", actor: "amy" });
    expect(ekman.entities.orders.inspect("1")).toEqual(
      ekman.inspect("orders:1")
    );
  });

  it.each([
    ["null", null],
    ["a string", "approve"],
    ["a number", 7],
  ])("rejects %s as a trigger", async (_why, trigger) => {
    const ekman = new Ekman({ entities: [orders] });
    expect(
      await code(ekman.send("orders:1", trigger as unknown as { type: string }))
    ).toBe("UNKNOWN_TRIGGER");
  });

  it("rejects a trigger whose type is an empty string", async () => {
    const ekman = new Ekman({ entities: [orders] });
    expect(await code(ekman.send("orders:1", { type: "" }))).toBe(
      "UNKNOWN_TRIGGER"
    );
  });

  it("logs a post() failure on stderr when no sink is configured", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const ekman = new Ekman({ entities: [orders] });
      ekman.entities.orders.post("1", { type: "cancel" });
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      expect(spy.mock.calls[0]?.[0]).toBe(
        "[ekman] unhandled failure (post for orders:1)"
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("names the source alone when a failure concerns no key", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const ekman = new Ekman({
        entities: [orders],
        telemetry: {
          "runtime.closed": () => {
            throw new Error("exporter is down");
          },
        },
      });
      await ekman.close();
      expect(spy.mock.calls[0]?.[0]).toBe(
        "[ekman] unhandled failure (telemetry)"
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("lists resident keys", async () => {
    const ekman = new Ekman({ entities: [orders] });
    await ekman.entities.orders.send("1", { type: "approve", actor: "amy" });
    await ekman.entities.orders.send("2", { type: "approve", actor: "bo" });
    expect([...ekman.residentKeys].sort()).toEqual(["orders:1", "orders:2"]);
  });
});

describe("remaining edges", () => {
  it("names no entities when a runtime has none registered", async () => {
    const ekman = new Ekman();
    try {
      await ekman.send("orders:1", { type: "go" });
      throw new Error("expected a rejection");
    } catch (err) {
      expect((err as EkmanError).code).toBe("UNKNOWN_ENTITY");
      expect((err as Error).message).toContain("(none)");
    }
  });

  it("lists the registered entities when the key names a different one", async () => {
    const ekman = new Ekman({ entities: [orders] });
    try {
      await ekman.send("invoices:1", { type: "go" });
      throw new Error("expected a rejection");
    } catch (err) {
      expect((err as Error).message).toContain("orders");
    }
  });

  it("reports the original failure when an error handler returns a non-result", async () => {
    const confused = defineEntity("confused", {
      initial: "a",
      states: { a: () => fail(new Error("the real problem")) },
      onError: { "*": () => "recovered" as unknown as ReturnType<typeof stay> },
    });
    const ekman = new Ekman({ entities: [confused] });

    try {
      await ekman.entities.confused.send("1", { type: "go" });
      throw new Error("expected a rejection");
    } catch (err) {
      expect((err as EkmanError).code).toBe("HANDLER_FAILED");
      expect((err as Error).message).toContain("the real problem");
    }
    expect(ekman.entities.confused.inspect("1")).toMatchObject({
      state: "a",
      seq: 0,
    });
  });

  it.each([
    ["undefined, the forgotten return", undefined],
    ["null", null],
    ["a number", 7],
    ["an object that is not a result", { kind: "nonsense" }],
  ])("treats a handler returning %s as a failure", async (_why, returned) => {
    const wrong = defineEntity("wrong", {
      initial: "a",
      states: { a: () => returned as unknown as ReturnType<typeof stay> },
    });
    const ekman = new Ekman({ entities: [wrong] });

    expect(await code(ekman.entities.wrong.send("1", { type: "go" }))).toBe(
      "HANDLER_FAILED"
    );
    expect(ekman.entities.wrong.inspect("1")).toMatchObject({
      state: "a",
      seq: 0,
    });
  });

  it("says what the handler returned instead, so the mistake is obvious", async () => {
    const wrong = defineEntity("wrong", {
      initial: "a",
      states: { a: () => undefined as unknown as ReturnType<typeof stay> },
    });
    const ekman = new Ekman({ entities: [wrong] });

    try {
      await ekman.entities.wrong.send("1", { type: "go" });
      throw new Error("expected a rejection");
    } catch (err) {
      expect((err as Error).message).toContain("undefined");
      expect((err as Error).message).toContain("transitionTo()");
    }
  });
});

const stalling = defineEntity("stalling", {
  initial: "deploying",
  states: {
    deploying: (_i, trigger) =>
      trigger.type === "constraint.temporal"
        ? transitionTo("stalled", { after: trigger.sinceMs as number })
        : stay(),
    stalled: () => stay(),
  },
  constraints: {
    temporal: [{ name: "too-slow", in: "deploying", within: 100 }],
  },
});

describe("sweeping for temporal constraints", () => {
  it("does nothing when no entity declares one", async () => {
    const ekman = new Ekman({ entities: [orders] });
    await ekman.entities.orders.send("1", { type: "approve", actor: "amy" });

    expect(await ekman.sweep()).toBe(0);
    await ekman.close();
  });

  it("fires once the bound has elapsed and reports how many fired", async () => {
    const clock = frozenClock();
    const ekman = new Ekman({ entities: [stalling], now: clock.now });
    await ekman.entities.stalling.send("a", { type: "start" });

    expect(await ekman.sweep()).toBe(0);
    clock.advance(100);
    expect(await ekman.sweep()).toBe(1);

    expect(ekman.entities.stalling.inspect("a")).toMatchObject({
      state: "stalled",
      values: { after: 100 },
    });
    await ekman.close();
  });

  it("returns immediately rather than overlapping a pass already running", async () => {
    const clock = frozenClock();
    const ekman = new Ekman({ entities: [stalling], now: clock.now });
    await ekman.entities.stalling.send("a", { type: "start" });
    clock.advance(500);

    // Both are started before either is awaited, so the second one meets the first
    // mid-pass. Overlapping passes would double-fire, which the guard exists to prevent.
    const [first, second] = await Promise.all([ekman.sweep(), ekman.sweep()]);

    expect(first + second).toBe(1);
    await ekman.close();
  });

  it("reports an escalation that could not be delivered rather than swallowing it", async () => {
    const stuck = defineEntity("stuck", {
      initial: "waiting",
      states: {
        waiting: (_instance, trigger) =>
          trigger.type === "constraint.temporal"
            ? fail(new Error("cannot move"))
            : stay(),
      },
      constraints: {
        temporal: [{ name: "waited", in: "waiting", within: 10 }],
      },
    });

    const clock = frozenClock();
    const unhandled: unknown[] = [];
    const events: TelemetryEvent[] = [];
    const ekman = new Ekman({
      entities: [stuck],
      now: clock.now,
      onUnhandled: (error) => unhandled.push(error),
      telemetry: { "*": (event) => events.push(event) },
    });

    await ekman.entities.stuck.send("a", { type: "begin" });
    clock.advance(50);
    expect(await ekman.sweep()).toBe(1);

    expect((unhandled[0] as EkmanError).code).toBe("HANDLER_FAILED");
    expect(events.find((e) => e.type === "constraint.escalated")).toMatchObject(
      { delivered: false, constraint: "waited" }
    );
    expect(await ekman.sweep()).toBe(0);
    await ekman.close();
  });

  it("tries a refused escalation again on the next sweep, recording one violation", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const busy = defineEntity("busy", {
      initial: "waiting",
      states: {
        waiting: async (_instance, trigger) => {
          if (trigger.type === "hold") {
            await held;
          }
          return trigger.type === "constraint.temporal"
            ? transitionTo("late")
            : stay();
        },
        late: () => stay(),
      },
      constraints: {
        temporal: [{ name: "waited", in: "waiting", within: 10 }],
      },
    });

    const clock = frozenClock();
    const unhandled: unknown[] = [];
    const escalated: boolean[] = [];
    const ekman = new Ekman({
      entities: [busy],
      now: clock.now,
      inbox: { capacity: 0 },
      onUnhandled: (error) => unhandled.push(error),
      telemetry: {
        "constraint.escalated": (event) => escalated.push(event.delivered),
      },
    });

    await ekman.entities.busy.send("a", { type: "start" });
    const holding = ekman.entities.busy.send("a", { type: "hold" });
    clock.advance(50);

    expect(await ekman.sweep()).toBe(1);
    expect((unhandled[0] as EkmanError).code).toBe("INBOX_OVERFLOW");

    release();
    await holding;
    expect(await ekman.sweep()).toBe(1);
    expect(await ekman.sweep()).toBe(0);

    expect(ekman.entities.busy.inspect("a")).toMatchObject({ state: "late" });
    expect(escalated).toEqual([false, true]);

    const { events } = await ekman.entities.busy.history("a");
    const violations = events.filter((event) => event.type === "violation");
    expect(violations).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "transition",
      to: "late",
      cause: violations[0]?.cause,
    });
    await ekman.close();
  });

  it("does not count a bound as fired for an entry the escalation was not raised for", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const roaming = defineEntity("roaming", {
      initial: "waiting",
      states: {
        waiting: async (_instance, trigger) => {
          if (trigger.type === "hold") {
            await held;
          }
          return trigger.type === "leave" ? transitionTo("away") : stay();
        },
        away: () => transitionTo("waiting"),
      },
      constraints: {
        temporal: [{ name: "waited", in: "waiting", within: 10 }],
      },
    });

    const clock = frozenClock();
    const ekman = new Ekman({ entities: [roaming], now: clock.now });
    await ekman.entities.roaming.send("a", { type: "start" });
    const queued = [
      ekman.entities.roaming.send("a", { type: "hold" }),
      ekman.entities.roaming.send("a", { type: "leave" }),
      ekman.entities.roaming.send("a", { type: "return" }),
    ];
    clock.advance(50);

    const sweeping = ekman.sweep();
    release();
    await Promise.all(queued);
    expect(await sweeping).toBe(1);

    clock.advance(50);
    expect(await ekman.sweep()).toBe(1);
    await ekman.close();
  });

  it("stops evaluating an instance once an escalation has moved it", async () => {
    const twice = defineEntity("twice", {
      initial: "waiting",
      states: {
        waiting: (_instance, trigger) =>
          trigger.type === "constraint.temporal"
            ? transitionTo("late")
            : stay(),
        late: () => stay(),
      },
      constraints: {
        temporal: [
          { name: "first", in: "waiting", within: 10 },
          { name: "second", in: "waiting", within: 20 },
        ],
      },
    });

    const clock = frozenClock();
    const ekman = new Ekman({ entities: [twice], now: clock.now });
    await ekman.entities.twice.send("a", { type: "start" });
    clock.advance(50);

    expect(await ekman.sweep()).toBe(1);

    const { events } = await ekman.entities.twice.history("a");
    expect(events.map((event) => `${event.type}@${event.seq}`)).toEqual([
      "transition@0",
      "transition@1",
      "violation@1",
      "transition@2",
    ]);
    await ekman.close();
  });

  it("sweeps on its own interval when one is configured", async () => {
    const clock = frozenClock();
    const ekman = new Ekman({
      entities: [stalling],
      now: clock.now,
      temporal: { sweepMs: 1 },
    });

    await ekman.entities.stalling.send("a", { type: "start" });
    clock.advance(500);

    await vi.waitFor(() =>
      expect(ekman.entities.stalling.inspect("a")).toMatchObject({
        state: "stalled",
      })
    );

    await ekman.close();
  });

  it("stops sweeping once closed", async () => {
    const clock = frozenClock();
    const ekman = new Ekman({
      entities: [stalling],
      now: clock.now,
      temporal: { sweepMs: 1 },
    });

    await ekman.entities.stalling.send("a", { type: "start" });
    await ekman.close();
    await ekman.close(); // idempotent: shutdown code should not have to check

    clock.advance(500);
    await new Promise((done) => setTimeout(done, 20));

    expect(ekman.entities.stalling.inspect("a")).toMatchObject({
      state: "deploying",
    });
  });

  it.each([0, -1, Number.NaN])(
    "refuses a sweep interval of %s at construction",
    (sweepMs) => {
      expect(
        () => new Ekman({ entities: [stalling], temporal: { sweepMs } })
      ).toThrow(EkmanError);
    }
  );

  it("skips a key that left the watched state while the pass was running", async () => {
    // A pass walks a snapshot of the keys in a state. An escalation is dispatched, so
    // anything it does can move a *different* instance out from under the rest of the
    // walk. The sweep has to notice rather than escalate against a stale reading.
    const holder: { ekman?: Ekman } = {};

    const gossip = defineEntity("gossip", {
      initial: "waiting",
      states: {
        waiting: async (instance, trigger) => {
          if (
            trigger.type === "constraint.temporal" &&
            instance.key === "gossip:a"
          ) {
            await holder.ekman?.send("gossip:b", { type: "move" });
          }
          return trigger.type === "move" ? transitionTo("done") : stay();
        },
        done: () => stay(),
      },
      constraints: {
        temporal: [{ name: "waited", in: "waiting", within: 10 }],
      },
    });

    const clock = frozenClock();
    const ekman = new Ekman({ entities: [gossip], now: clock.now });
    holder.ekman = ekman;

    await ekman.entities.gossip.send("a", { type: "start" });
    await ekman.entities.gossip.send("b", { type: "start" });
    clock.advance(100);

    // Only `a` fires. By the time the walk reaches `b` it has already moved to `done`,
    // which nothing watches.
    expect(await ekman.sweep()).toBe(1);
    expect(ekman.entities.gossip.inspect("b")).toMatchObject({ state: "done" });
    await ekman.close();
  });

  it("skips an instance the index no longer agrees with", async () => {
    const clock = frozenClock();
    const ekman = new Ekman({ entities: [stalling], now: clock.now });

    await ekman.entities.stalling.send("a", { type: "start" });
    clock.advance(500);
    await ekman.sweep();

    // Now in `stalled`, which nothing watches. A second pass finds the key gone from the
    // watched bucket and must not fire again.
    expect(await ekman.sweep()).toBe(0);
    await ekman.close();
  });
});

describe("forgetting an instance", () => {
  const tickets = defineEntity("tickets", {
    initial: "open",
    values: { note: "" },
    states: {
      open: (ticket, trigger) =>
        trigger.type === "close"
          ? transitionTo("closed", ticket.values)
          : stay({ note: String(trigger.note ?? "") }),
      closed: (ticket) => stay(ticket.values),
    },
  });

  it("removes the instance, its state and its stream", async () => {
    const ekman = new Ekman({ entities: [tickets], store: "memory" });
    await ekman.entities.tickets.send("t1", { type: "poke", note: "hello" });

    await ekman.entities.tickets.forget("t1");

    expect(ekman.entities.tickets.inspect("t1")).toBeUndefined();
    const { events } = await ekman.entities.tickets.history("t1");
    expect(events).toEqual([]);
    await ekman.close();
  });

  it("lets the same id come back as a genuinely new instance", async () => {
    const ekman = new Ekman({ entities: [tickets], store: "memory" });
    await ekman.entities.tickets.send("t1", { type: "close" });
    expect(ekman.entities.tickets.inspect("t1")?.state).toBe("closed");

    await ekman.entities.tickets.forget("t1");
    const revived = await ekman.entities.tickets.send("t1", { type: "poke" });

    // Indistinguishable from a key this runtime has never seen: same initial state, same
    // sequence. Anything carried over would mean something survived that should not have.
    const control = await ekman.entities.tickets.send("never-seen", {
      type: "poke",
    });
    expect(revived.state).toBe(control.state);
    expect(revived.seq).toBe(control.seq);
    await ekman.close();
  });

  it("leaves its neighbours alone", async () => {
    const ekman = new Ekman({ entities: [tickets], store: "memory" });
    await ekman.entities.tickets.send("t1", { type: "poke" });
    await ekman.entities.tickets.send("t2", { type: "poke" });

    await ekman.entities.tickets.forget("t1");

    expect(ekman.entities.tickets.inspect("t2")).toBeDefined();
    const { instances } = await ekman.entities.tickets.query({});
    expect(instances.map((match) => match.key)).toEqual(["tickets:t2"]);
    await ekman.close();
  });

  it("refuses while a handler is in flight, rather than deleting under it", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slow = defineEntity("slow", {
      initial: "idle",
      states: {
        idle: async (instance) => {
          await held;
          return stay(instance.values);
        },
      },
    });

    const ekman = new Ekman({ entities: [slow], store: "memory" });
    const inFlight = ekman.entities.slow.send("s1", { type: "go" });

    // A commit landing into a key that had just been deleted would resurrect it at a
    // sequence nothing accounts for, so this is refused rather than raced.
    await expect(ekman.entities.slow.forget("s1")).rejects.toMatchObject({
      code: "KEY_BUSY",
    });

    release();
    await inFlight;

    // And once it is idle the same call goes through.
    await ekman.entities.slow.forget("s1");
    expect(ekman.entities.slow.inspect("s1")).toBeUndefined();
    await ekman.close();
  });

  it("makes a send that arrives mid-forget start a fresh instance", async () => {
    const inner = memoryStore();
    const store: Store = {
      name: inner.name,
      capabilities: inner.capabilities,
      append: async (key, event, expectedSeq) => {
        if (event.type === "rejected") {
          await new Promise((done) => setTimeout(done, 30));
        }
        return inner.append(key, event, expectedSeq);
      },
      load: inner.load.bind(inner),
      read: inner.read.bind(inner),
      snapshot: inner.snapshot.bind(inner),
      scan: inner.scan.bind(inner),
      forget: inner.forget.bind(inner),
    };
    const gated = defineEntity("gated", {
      initial: "open",
      triggers: ["poke"],
      states: { open: () => stay() },
    });
    const ekman = new Ekman({ entities: [gated], store });

    await ekman.entities.gated.send("g1", { type: "poke" });
    await ekman.entities.gated.send("g1", { type: "bogus" }).catch(() => 0);

    const forgetting = ekman.entities.gated.forget("g1");
    const sent = ekman.entities.gated.send("g1", { type: "poke" });
    await forgetting;

    expect(await sent).toMatchObject({ seq: 1 });
    const { events } = await ekman.entities.gated.history("g1");
    expect(events.map((event) => `${event.type}@${event.seq}`)).toEqual([
      "transition@0",
      "transition@1",
    ]);
    await ekman.close();
  });

  it("holds a send back until every layer has finished deleting, even when one fails", async () => {
    const cache = memoryStore({ name: "cache" });
    const truth = memoryStore({ name: "truth", authority: true });
    const failing: Store = {
      name: cache.name,
      capabilities: cache.capabilities,
      append: cache.append.bind(cache),
      load: cache.load.bind(cache),
      read: cache.read.bind(cache),
      snapshot: cache.snapshot.bind(cache),
      scan: cache.scan.bind(cache),
      forget: () => Promise.reject(new Error("cache cannot delete right now")),
    };
    const slow: Store = {
      name: truth.name,
      capabilities: truth.capabilities,
      authority: true,
      append: truth.append.bind(truth),
      load: truth.load.bind(truth),
      read: truth.read.bind(truth),
      snapshot: truth.snapshot.bind(truth),
      scan: truth.scan.bind(truth),
      forget: async (key) => {
        await new Promise((done) => setTimeout(done, 30));
        await truth.forget(key);
      },
    };
    const ekman = new Ekman({ entities: [tickets], store: [failing, slow] });
    await ekman.entities.tickets.send("t1", { type: "poke" });
    await ekman.entities.tickets.send("t1", { type: "poke" });

    const forgetting = ekman.entities.tickets.forget("t1");
    const sent = ekman.entities.tickets.send("t1", { type: "poke" });

    await expect(forgetting).rejects.toThrow("cache cannot delete right now");
    expect(await sent).toMatchObject({ seq: 1 });
    expect(await truth.read("tickets:t1")).toHaveLength(2);
    await ekman.close();
  });

  it("lets two forgets of one key overlap", async () => {
    const ekman = new Ekman({ entities: [tickets], store: "memory" });
    await ekman.entities.tickets.send("t1", { type: "poke" });

    await Promise.all([
      ekman.entities.tickets.forget("t1"),
      ekman.entities.tickets.forget("t1"),
    ]);

    const revived = await ekman.entities.tickets.send("t1", { type: "poke" });
    expect(revived.seq).toBe(1);
    const { events } = await ekman.entities.tickets.history("t1");
    expect(events).toHaveLength(2);
    await ekman.close();
  });

  it("is not an error for a key that was never here", async () => {
    // So a sweep that dies halfway behaves the same way when it is run again.
    const ekman = new Ekman({ entities: [tickets], store: "memory" });
    await expect(
      ekman.entities.tickets.forget("nobody")
    ).resolves.toBeUndefined();
    await ekman.close();
  });

  it("gives the memory budget its bytes back", async () => {
    const ekman = new Ekman({ entities: [tickets], store: "memory" });
    await ekman.entities.tickets.send("t1", { type: "poke", note: "x" });
    const held = ekman.memoryUsage;
    expect(held.instances).toBe(1);

    await ekman.entities.tickets.forget("t1");

    expect(ekman.memoryUsage.instances).toBe(0);
    expect(ekman.memoryUsage.bytes).toBeLessThan(held.bytes);
    await ekman.close();
  });

  it("clears every layer, not only the one that owns the truth", async () => {
    const ekman = new Ekman({
      entities: [tickets],
      store: ["memory", { kind: "memory", name: "second" }],
    });
    await ekman.entities.tickets.send("t1", { type: "poke" });

    await ekman.entities.tickets.forget("t1");

    // A cache still holding the stream would serve it back on the next load, which is the
    // opposite of forgotten, and would show up as a sequence carried over.
    const revived = await ekman.entities.tickets.send("t1", { type: "poke" });
    const control = await ekman.entities.tickets.send("never-seen", {
      type: "poke",
    });
    expect(revived.seq).toBe(control.seq);
    await ekman.close();
  });

  it("reports the deletion as its own kind of event", async () => {
    const seen: TelemetryEvent[] = [];
    const ekman = new Ekman({
      entities: [tickets],
      store: "memory",
      telemetry: { "instance.forgotten": (event) => seen.push(event) },
    });
    await ekman.entities.tickets.send("t1", { type: "close" });

    await ekman.entities.tickets.forget("t1");

    // Eviction frees memory and keeps the truth; this destroys it. Reading one stream
    // should never leave an operator guessing which happened.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: "instance.forgotten",
      key: "tickets:t1",
      entity: "tickets",
      state: "closed",
      resident: true,
    });
    await ekman.close();
  });

  it("refuses when a layer cannot delete, before touching anything", async () => {
    const stubborn = {
      name: "stubborn",
      capabilities: {
        durability: "ephemeral" as const,
        conditionalAppend: true,
        multiWriter: false,
        scan: { byState: false, olderThan: false },
        forget: false,
        compact: false,
      },
      append: () => Promise.resolve(),
      load: () => Promise.resolve(undefined),
      read: () => Promise.resolve([]),
      snapshot: () => Promise.resolve(),
      scan: () =>
        Promise.resolve({ matches: [], unsupported: [], complete: true }),
    };

    const ekman = new Ekman({
      entities: [tickets],
      store: ["memory", stubborn],
    });
    await ekman.entities.tickets.send("t1", { type: "poke" });

    await expect(ekman.entities.tickets.forget("t1")).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });

    // Refused before anything was deleted, so the runtime is exactly as it was rather
    // than half-forgotten.
    expect(ekman.entities.tickets.inspect("t1")).toBeDefined();
    await ekman.close();
  });
});

describe("storage usage", () => {
  const tickets = defineEntity("tickets", {
    initial: "open",
    values: { note: "" },
    states: { open: (t) => stay(t.values) },
  });

  it("reports nothing when no layer accounts for itself", () => {
    // The memory store keeps no bytes on disk to report, and inventing a number for it
    // would be worse than saying nothing.
    const ekman = new Ekman({ entities: [tickets], store: "memory" });
    expect(ekman.storageUsage).toEqual({ bytes: 0, logs: 0, maxBytes: null });
  });

  it("reports nothing for a runtime that keeps nothing", () => {
    const ekman = new Ekman({ entities: [tickets], store: "none" });
    expect(ekman.storageUsage).toEqual({ bytes: 0, logs: 0, maxBytes: null });
  });

  it("stays separate from the resident budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ekman-usage-"));
    const ekman = new Ekman({
      entities: [tickets],
      store: ["memory", { kind: "file", dir }],
    });
    await ekman.entities.tickets.send("t1", { type: "poke" });

    // Two different questions. Collapsing them would hide whichever one is actually the
    // constraint.
    expect(ekman.storageUsage.bytes).toBeGreaterThan(0);
    expect(ekman.storageUsage.logs).toBe(1);
    expect(ekman.memoryUsage.instances).toBe(1);

    await ekman.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports the ceiling when one is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ekman-usage-"));
    const ekman = new Ekman({
      entities: [tickets],
      store: { kind: "file", dir, retention: { totalBytes: 4096 } },
    });
    await ekman.entities.tickets.send("t1", { type: "poke" });

    expect(ekman.storageUsage.maxBytes).toBe(4096);

    await ekman.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("sweeping storage", () => {
  const tickets = defineEntity("tickets", {
    initial: "open",
    // Enough per commit that a handful of them pass a small budget.
    states: { open: () => stay({ note: "x".repeat(200) }) },
  });

  /** A runtime over a fresh directory, with the store told what to do at its budget. */
  const bounded = (
    dir: string,
    retention: { totalBytes: number; policy: "compact" | "reject" },
    telemetry?: TelemetryEvent[]
  ) =>
    new Ekman({
      entities: [tickets],
      store: {
        kind: "file",
        dir,
        // Per-log compaction off, so the sweep is the only thing that can reclaim and
        // nothing happens on the commit path to muddy what is being measured.
        retention: { perLogBytes: 0, ...retention },
      },
      ...(telemetry === undefined
        ? {}
        : { telemetry: { "*": (event) => telemetry.push(event) } }),
    });

  it("reclaims bytes without touching state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ekman-sweep-"));
    const ekman = bounded(dir, { totalBytes: 1200, policy: "compact" });

    for (const id of ["t1", "t2", "t3"]) {
      for (let i = 0; i < 4; i += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: commits have to land in order for the byte totals to mean anything
        await ekman.entities.tickets.send(id, { type: "poke" });
      }
    }

    const before = ekman.storageUsage.bytes;
    const swept = await ekman.sweepStorage();

    expect(swept.logs).toBeGreaterThan(0);
    expect(swept.reclaimed).toBeGreaterThan(0);
    expect(swept.overBudget).toEqual([]);
    expect(ekman.storageUsage.bytes).toBeLessThan(before);

    // The whole claim: history is what a sweep costs, and nothing else is.
    const current = ekman.entities.tickets.inspect("t1");
    expect(current?.seq).toBe(4);
    expect(current?.values.note).toBe("x".repeat(200));
    const { complete, reasons } = await ekman.entities.tickets.history("t1");
    expect(complete).toBe(false);
    expect(reasons).toContain("compacted");

    await ekman.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not call a stream complete when every event of it was folded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ekman-sweep-"));
    const ekman = bounded(dir, { totalBytes: 1, policy: "compact" });
    await ekman.entities.tickets.send("t1", { type: "poke" });
    await ekman.sweepStorage();

    // Compaction can fold every event a key has and leave an empty stream behind. Asking
    // the events which sequence they start at cannot tell that apart from a key nothing
    // ever addressed, and answering "complete" for a key that has plainly lived is the
    // same lie in a rarer shape.
    const { events, complete, reasons } =
      await ekman.entities.tickets.history("t1");
    expect(events).toHaveLength(0);
    expect(complete).toBe(false);
    expect(reasons).toContain("compacted");

    // A key nothing ever addressed still answers the other way, because it has no
    // snapshot behind it either.
    const untouched = await ekman.entities.tickets.history("nobody");
    expect(untouched.complete).toBe(true);

    await ekman.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the layers it could not bring under their bound", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ekman-sweep-"));
    // Below what the snapshots alone weigh, so the sweep reaches its floor still over.
    const ekman = bounded(dir, { totalBytes: 1, policy: "compact" });
    await ekman.entities.tickets.send("t1", { type: "poke" });

    const swept = await ekman.sweepStorage();

    // Named rather than counted, because "something is over" is not actionable.
    expect(swept.overBudget).toEqual(["file"]);

    await ekman.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits what each layer reclaimed, with no key on the event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ekman-sweep-"));
    const telemetry: TelemetryEvent[] = [];
    const ekman = bounded(
      dir,
      { totalBytes: 600, policy: "compact" },
      telemetry
    );

    for (let i = 0; i < 5; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: commits have to land in order
      await ekman.entities.tickets.send("t1", { type: "poke" });
    }
    await ekman.sweepStorage();

    // An interval sweep has no caller holding its result, so the event is the only way it
    // could be observed at all.
    const swept = telemetry.filter((event) => event.type === "storage.swept");
    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({ store: "file", maxBytes: 600 });
    // The one event here that belongs to a store rather than to an instance.
    expect(swept[0]).not.toHaveProperty("key");

    await ekman.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips layers that cannot compact, rather than refusing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ekman-sweep-"));
    const ekman = new Ekman({
      entities: [tickets],
      // A memory cache in front of a file authority. Sweeping the stack must not become
      // an error just because one layer has nothing to reclaim.
      store: ["memory", { kind: "file", dir }],
    });
    await ekman.entities.tickets.send("t1", { type: "poke" });

    await expect(ekman.sweepStorage()).resolves.toEqual({
      logs: 0,
      reclaimed: 0,
      overBudget: [],
    });

    await ekman.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a layer that compacts without accounting for itself", async () => {
    // `usage` is optional on the contract: an adapter can reclaim space and have no
    // meaningful byte total to report, and inventing one for it would be worse than
    // saying nothing. The sweep still has to work and still has to say what it did.
    const silent = {
      name: "silent",
      capabilities: {
        durability: "ephemeral" as const,
        conditionalAppend: true,
        multiWriter: false,
        scan: { byState: false, olderThan: false },
        forget: false,
        compact: true,
      },
      append: () => Promise.resolve(),
      load: () => Promise.resolve(undefined),
      read: () => Promise.resolve([]),
      snapshot: () => Promise.resolve(),
      scan: () =>
        Promise.resolve({ matches: [], unsupported: [], complete: true }),
      compact: () =>
        Promise.resolve({ logs: 2, reclaimed: 512, withinBudget: true }),
    };

    const telemetry: TelemetryEvent[] = [];
    const ekman = new Ekman({
      entities: [tickets],
      store: silent,
      telemetry: { "*": (event) => telemetry.push(event) },
    });

    await expect(ekman.sweepStorage()).resolves.toEqual({
      logs: 2,
      reclaimed: 512,
      overBudget: [],
    });
    expect(
      telemetry.find((event) => event.type === "storage.swept")
    ).toMatchObject({ store: "silent", bytes: 0, maxBytes: null });

    await ekman.close();
  });

  it("returns an empty pass rather than queueing behind one already running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ekman-sweep-"));
    const ekman = bounded(dir, { totalBytes: 400, policy: "compact" });
    for (let i = 0; i < 4; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: commits have to land in order
      await ekman.entities.tickets.send("t1", { type: "poke" });
    }

    // Overlapping passes are not useful: the second would walk a store the first is
    // rewriting underneath it.
    const [first, second] = await Promise.all([
      ekman.sweepStorage(),
      ekman.sweepStorage(),
    ]);

    expect(first.reclaimed).toBeGreaterThan(0);
    expect(second).toEqual({ logs: 0, reclaimed: 0, overBudget: [] });

    await ekman.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an interval that could never reclaim anything", () => {
    // A setting that looks configured and does nothing is the failure this whole area of
    // the config exists to refuse.
    expect(
      () =>
        new Ekman({
          entities: [tickets],
          store: "memory",
          storage: { sweepMs: 10 },
        })
    ).toThrow(NOTHING_TO_COMPACT);
  });

  it("refuses an interval that is not one", () => {
    const dir = mkdtempSync(join(tmpdir(), "ekman-sweep-"));
    expect(
      () =>
        new Ekman({
          entities: [tickets],
          store: { kind: "file", dir },
          storage: { sweepMs: 0 },
        })
    ).toThrow(POSITIVE_MILLISECONDS);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reclaims on its own once an interval is set, and stops on close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ekman-sweep-"));
    const telemetry: TelemetryEvent[] = [];
    const ekman = new Ekman({
      entities: [tickets],
      store: {
        kind: "file",
        dir,
        retention: { perLogBytes: 0, totalBytes: 600, policy: "compact" },
      },
      storage: { sweepMs: 5 },
      telemetry: { "*": (event) => telemetry.push(event) },
    });

    for (let i = 0; i < 5; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: commits have to land in order
      await ekman.entities.tickets.send("t1", { type: "poke" });
    }

    await new Promise((done) => setTimeout(done, 40));
    expect(
      telemetry.filter((event) => event.type === "storage.swept").length
    ).toBeGreaterThan(0);

    await ekman.close();
    const afterClose = telemetry.filter(
      (event) => event.type === "storage.swept"
    ).length;
    await new Promise((done) => setTimeout(done, 30));

    // Closed means closed. An interval left running would keep rewriting a store the
    // caller believes it has finished with.
    expect(
      telemetry.filter((event) => event.type === "storage.swept")
    ).toHaveLength(afterClose);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("history after compaction", () => {
  const tickets = defineEntity("tickets", {
    initial: "open",
    values: { note: "" },
    states: { open: () => stay({ note: "x".repeat(200) }) },
  });

  it("reports itself incomplete once events have been folded away", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ekman-compact-"));
    const ekman = new Ekman({
      entities: [tickets],
      store: { kind: "file", dir, retention: { perLogBytes: 1024 } },
    });

    for (let i = 0; i < 40; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each commit has to land before the next
      await ekman.entities.tickets.send("t1", { type: "update" });
    }
    // A log past its limit is compacted on the next turn of the event loop.
    await new Promise((done) => {
      setImmediate(done);
    });

    const { events, complete, reasons } =
      await ekman.entities.tickets.history("t1");

    // The state is untouched; only the middle of the stream is gone. Saying so is the
    // whole point, because a shorter answer passing as a whole one is the failure mode.
    expect(events.length).toBeLessThan(40);
    expect(complete).toBe(false);
    expect(reasons).toEqual(["compacted"]);
    expect(ekman.entities.tickets.inspect("t1")?.seq).toBe(40);

    await ekman.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports itself incomplete even when a refusal survives at the first sequence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ekman-compact-"));
    const declared = defineEntity("tickets", {
      initial: "open",
      values: { note: "" },
      triggers: ["update"],
      states: { open: () => stay({ note: "x".repeat(200) }) },
    });
    const ekman = new Ekman({
      entities: [declared],
      store: { kind: "file", dir, retention: { perLogBytes: 1024 } },
    });

    await expect(
      ekman.entities.tickets.send("t1", { type: "nonsense" } as never)
    ).rejects.toMatchObject({ code: "UNKNOWN_TRIGGER" });
    for (let i = 0; i < 40; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each commit has to land before the next
      await ekman.entities.tickets.send("t1", { type: "update" });
    }
    // A log past its limit is compacted on the next turn of the event loop.
    await new Promise((done) => {
      setImmediate(done);
    });

    const { events, complete, reasons } =
      await ekman.entities.tickets.history("t1");

    expect(events[0]).toMatchObject({ type: "rejected", seq: 0 });
    expect(complete).toBe(false);
    expect(reasons).toEqual(["compacted"]);

    await ekman.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stays complete when nothing has been compacted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ekman-compact-"));
    const ekman = new Ekman({
      entities: [tickets],
      store: { kind: "file", dir, retention: { perLogBytes: 0 } },
    });
    await ekman.entities.tickets.send("t1", { type: "update" });

    const { complete, reasons } = await ekman.entities.tickets.history("t1");
    expect(complete).toBe(true);
    expect(reasons).toEqual([]);

    await ekman.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("refusing configuration at construction", () => {
  it("refuses a runtime-wide execution policy no attempt could satisfy", () => {
    expect(() => new Ekman({ execution: { maxAttempts: 0 } })).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG" })
    );
  });

  it("refuses an entity whose state policy no attempt could satisfy", () => {
    const impatient = defineEntity("impatient", {
      initial: "a",
      states: { a: { handler: () => stay(), timeoutMs: -1 } },
    });

    expect(() => new Ekman({ entities: [impatient] })).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG" })
    );
    expect(() => new Ekman().define(impatient)).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG" })
    );
  });

  it.each([
    ["temporal", { temporal: { sweepMs: 2 ** 31 } }],
    ["storage", { storage: { sweepMs: 2 ** 31 }, store: "memory" }],
  ] as const)(
    "refuses a %s sweep interval a timer cannot hold",
    (_which, config) => {
      expect(() => new Ekman(config)).toThrow(
        expect.objectContaining({ code: "INVALID_CONFIG" })
      );
    }
  );

  it.each([
    ["the runtime", { entites: [] }, '"entites"'],
    ["inbox", { inbox: { capcity: 1 } }, '"capcity"'],
    ["memory", { memory: { maxbytes: 10 } }, '"maxbytes"'],
    ["eviction", { memory: { eviction: { polcy: "lru" } } }, '"polcy"'],
    ["execution", { execution: { maxAttempt: 2 } }, '"maxAttempt"'],
    ["temporal", { temporal: { sweepMS: 5 } }, '"sweepMS"'],
    ["storage", { storage: { sweepMS: 5 } }, '"sweepMS"'],
    [
      "telemetry",
      { telemetry: { "handler.setled": () => undefined } },
      '"handler.setled"',
    ],
  ])("refuses a misspelled option on %s", (_where, config, naming) => {
    const constructing = () => new Ekman(config as never);

    expect(constructing).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG" })
    );
    expect(constructing).toThrow(naming);
  });

  it("accepts every telemetry event name and the fallback", () => {
    const ekman = new Ekman({
      telemetry: { "*": () => undefined, "handler.settled": () => undefined },
    });

    expect(ekman.entityNames).toEqual([]);
  });
});

describe("values a handler cannot corrupt or commit", () => {
  it("keeps nested initial values out of a handler's reach", async () => {
    const carts = defineEntity("carts", {
      initial: "open",
      values: { nested: { n: 1 } },
      states: {
        open: (cart, trigger) => {
          if (trigger.type === "tamper") {
            (cart.values.nested as { n: number }).n = 5;
          }
          return stay(cart.values);
        },
      },
    });
    const ekman = new Ekman({ entities: [carts] });

    expect(await code(ekman.entities.carts.send("a", { type: "tamper" }))).toBe(
      "HANDLER_FAILED"
    );
    const other = await ekman.entities.carts.send("b", { type: "read" });
    expect(other.values).toEqual({ nested: { n: 1 } });
    await ekman.close();
  });

  it("refuses a value JSON cannot represent, leaving the instance as it was", async () => {
    const audited: string[] = [];
    const sums = defineEntity("sums", {
      initial: "open",
      states: { open: () => stay({ big: 10n }) },
    });
    const ekman = new Ekman({
      entities: [sums],
      audit: [
        {
          name: "trail",
          deliver: (event) => {
            audited.push(`${event.type}@${event.seq}`);
          },
        },
      ],
    });

    expect(await code(ekman.entities.sums.send("a", { type: "add" }))).toBe(
      "HANDLER_FAILED"
    );
    expect(ekman.entities.sums.inspect("a")).toMatchObject({
      seq: 0,
      values: {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(audited).toEqual(["transition@0"]);
    await ekman.close();
  });
});

describe("deciding whether a failure is worth another attempt", () => {
  class Flaky extends Error {
    override name = "Flaky";
  }

  const flakyOnce = () => {
    let calls = 0;
    return defineEntity("jobs", {
      initial: "open",
      states: {
        open: () => {
          calls += 1;
          if (calls === 1) {
            throw new Flaky("carrier unavailable");
          }
          return stay({ calls });
        },
      },
    });
  };

  const retrying = (retryable: (error: Error) => boolean) =>
    new Ekman({
      entities: [flakyOnce()],
      execution: {
        maxAttempts: 2,
        backoff: { kind: "fixed", delayMs: 0 },
        retryable,
      },
    });

  it("hands the predicate the error the handler threw", async () => {
    const ekman = retrying((error) => error instanceof Flaky);

    const result = await ekman.entities.jobs.send("a", { type: "run" });

    expect(result.values).toEqual({ calls: 2 });
    await ekman.close();
  });

  it("still reports the failure to the sender as a handler failure", async () => {
    const ekman = retrying((error) => error.name === "Other");

    const refused = await ekman.entities.jobs
      .send("a", { type: "run" })
      .catch((error: EkmanError) => error);

    expect(refused).toMatchObject({
      code: "HANDLER_FAILED",
      message:
        'handler for jobs:a in "open" failed on "run": carrier unavailable',
    });
    expect((refused as EkmanError).cause).toBeInstanceOf(Flaky);
    await ekman.close();
  });

  it("retries a handler failure by default, whatever the handler threw", async () => {
    let calls = 0;
    const nested = defineEntity("nested", {
      initial: "open",
      states: {
        open: () => {
          calls += 1;
          if (calls === 1) {
            throw new EkmanError("INBOX_OVERFLOW", "another key was full");
          }
          return stay();
        },
      },
    });
    const ekman = new Ekman({
      entities: [nested],
      execution: { maxAttempts: 2, backoff: { kind: "fixed", delayMs: 0 } },
    });

    await ekman.entities.nested.send("a", { type: "run" });

    expect(calls).toBe(2);
    await ekman.close();
  });
});

describe("history held in memory", () => {
  const counting = defineEntity("counting", {
    initial: "open",
    values: { n: 0 },
    states: { open: (instance) => stay({ n: instance.values.n + 1 }) },
  });

  it("is capped per key, and says so once the cap has been reached", async () => {
    const ekman = new Ekman({ entities: [counting] });
    const send = () => ekman.entities.counting.send("a", { type: "tick" });

    await send();
    const early = await ekman.entities.counting.history("a");
    expect(early.reasons).toEqual(["no-durable-store"]);

    for (let n = 0; n < RESIDENT_HISTORY_LIMIT; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: one key is fully serialized
      await send();
    }

    const late = await ekman.entities.counting.history("a");
    expect(late.events).toHaveLength(RESIDENT_HISTORY_LIMIT);
    expect(late.events.at(-1)).toMatchObject({
      seq: RESIDENT_HISTORY_LIMIT + 1,
    });
    expect(late.complete).toBe(false);
    expect(late.reasons).toEqual(["no-durable-store", "history-capped"]);
    expect(ekman.entities.counting.inspect("a")?.values).toEqual({
      n: RESIDENT_HISTORY_LIMIT + 1,
    });
    await ekman.close();
  });

  it("is not capped when a store holds the stream", async () => {
    const ekman = new Ekman({ entities: [counting], store: "memory" });

    for (let n = 0; n < RESIDENT_HISTORY_LIMIT + 10; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: one key is fully serialized
      await ekman.entities.counting.send("a", { type: "tick" });
    }

    const { events, reasons } = await ekman.entities.counting.history("a");
    expect(events).toHaveLength(RESIDENT_HISTORY_LIMIT + 11);
    expect(reasons).not.toContain("history-capped");
    await ekman.close();
  });
});

describe("closing the runtime", () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  const slow = (ms: number) =>
    defineEntity("slow", {
      initial: "open",
      states: {
        open: async () => {
          await new Promise((done) => setTimeout(done, ms));
          return stay({ done: true });
        },
      },
    });

  it("refuses a trigger once it has been closed", async () => {
    const ekman = new Ekman({ entities: [orders] });
    await ekman.close();

    expect(await code(ekman.send("orders:1", { type: "approve" }))).toBe(
      "RUNTIME_CLOSED"
    );
    expect(await ekman.sweep()).toBe(0);
    expect(await ekman.sweepStorage()).toMatchObject({ reclaimed: 0 });
    await expect(ekman.close()).resolves.toBeUndefined();
  });

  it("reports a post made after closing rather than dropping it", async () => {
    const unhandled: unknown[] = [];
    const ekman = new Ekman({
      entities: [orders],
      onUnhandled: (error) => unhandled.push(error),
    });
    await ekman.close();

    ekman.post("orders:1", { type: "approve" });
    await tick();

    expect(unhandled).toHaveLength(1);
    expect(unhandled[0]).toMatchObject({ code: "RUNTIME_CLOSED" });
  });

  it("waits for a handler in flight, and its commit lands", async () => {
    const closed: TelemetryEvent[] = [];
    const ekman = new Ekman({
      entities: [slow(30)],
      store: "memory",
      telemetry: { "runtime.closed": (event) => closed.push(event) },
    });
    const sent = ekman.entities.slow.send("a", { type: "go" });
    let landed = false;
    sent.then(() => {
      landed = true;
    });

    await ekman.close();

    expect(landed).toBe(true);
    expect(await sent).toMatchObject({ seq: 1 });
    expect(closed).toEqual([
      expect.objectContaining({ drained: true, pending: 0 }),
    ]);
  });

  it("gives up waiting at its deadline, and says what was left", async () => {
    const closed: TelemetryEvent[] = [];
    const stuck = defineEntity("stuck", {
      initial: "open",
      states: { open: () => new Promise<never>(() => undefined) },
    });
    const ekman = new Ekman({
      entities: [stuck],
      telemetry: { "runtime.closed": (event) => closed.push(event) },
    });
    ekman.entities.stuck.send("a", { type: "go" }).catch(() => undefined);

    const started = performance.now();
    await ekman.close({ timeoutMs: 20 });

    expect(performance.now() - started).toBeLessThan(500);
    expect(closed).toEqual([
      expect.objectContaining({ drained: false, pending: 1 }),
    ]);
  });

  it("shares one shutdown between callers that overlap", async () => {
    const closed: TelemetryEvent[] = [];
    const ekman = new Ekman({
      entities: [slow(10)],
      telemetry: { "runtime.closed": (event) => closed.push(event) },
    });
    ekman.entities.slow.send("a", { type: "go" });

    await Promise.all([ekman.close(), ekman.close()]);

    expect(closed).toHaveLength(1);
  });

  it.each([0, -1, Number.NaN, 2 ** 31])(
    "refuses a deadline of %s",
    async (timeoutMs) => {
      const ekman = new Ekman({ entities: [orders] });

      expect(await code(ekman.close({ timeoutMs }))).toBe("INVALID_CONFIG");
      await ekman.close();
    }
  );

  it("waits for a deletion in flight before closing the stores under it", async () => {
    const order: string[] = [];
    const inner = memoryStore();
    const store: Store = {
      name: inner.name,
      capabilities: inner.capabilities,
      append: inner.append.bind(inner),
      load: inner.load.bind(inner),
      read: inner.read.bind(inner),
      snapshot: inner.snapshot.bind(inner),
      scan: inner.scan.bind(inner),
      forget: async (key) => {
        await new Promise((done) => setTimeout(done, 30));
        await inner.forget(key);
        order.push("forgotten");
      },
      close: () => {
        order.push("closed");
        return Promise.resolve();
      },
    };
    const ekman = new Ekman({ entities: [orders], store });
    await ekman.entities.orders.send("1", { type: "approve", actor: "amy" });

    const forgetting = ekman.forget("orders:1");
    await ekman.close();
    await forgetting;

    expect(order).toEqual(["forgotten", "closed"]);
  });

  it("refuses to delete once it has been closed", async () => {
    const ekman = new Ekman({ entities: [orders], store: "memory" });
    await ekman.close();

    expect(await code(ekman.forget("orders:1"))).toBe("RUNTIME_CLOSED");
  });

  it("starts no further attempt for a handler that fails while it is closing", async () => {
    let calls = 0;
    const failing = defineEntity("failing", {
      initial: "open",
      states: {
        open: async () => {
          calls += 1;
          await new Promise((done) => setTimeout(done, 20));
          return fail(new Error("not yet"));
        },
      },
    });
    const ekman = new Ekman({
      entities: [failing],
      execution: { maxAttempts: 3, backoff: { kind: "fixed", delayMs: 0 } },
    });
    const sent = code(ekman.entities.failing.send("a", { type: "go" }));

    await ekman.close();

    expect(await sent).toBe("RUNTIME_CLOSED");
    expect(calls).toBe(1);
  });

  it("abandons a retry that is waiting out its backoff", async () => {
    let calls = 0;
    const flaky = defineEntity("flaky", {
      initial: "open",
      states: {
        open: () => {
          calls += 1;
          return fail(new Error("not yet"));
        },
      },
    });
    const settled: TelemetryEvent[] = [];
    const ekman = new Ekman({
      entities: [flaky],
      execution: {
        maxAttempts: 3,
        backoff: { kind: "fixed", delayMs: 10_000 },
      },
      telemetry: { "handler.settled": (event) => settled.push(event) },
    });
    const sent = code(ekman.entities.flaky.send("a", { type: "go" }));
    await tick();

    const started = performance.now();
    await ekman.close({ timeoutMs: 5000 });

    expect(await sent).toBe("RUNTIME_CLOSED");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(calls).toBe(1);
    expect(settled).toEqual([expect.objectContaining({ outcome: "failed" })]);
  });
});

describe("audit sinks and the commit path", () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it("does not run a sink inside the commit it is told about", async () => {
    const seen: string[] = [];
    const ekman = new Ekman({
      entities: [orders],
      audit: [
        {
          name: "trail",
          deliver: (event) => {
            seen.push(`${event.type}@${event.seq}`);
          },
        },
      ],
    });

    await ekman.entities.orders.send("1", { type: "approve", actor: "amy" });
    expect(seen).toEqual([]);

    await tick();
    expect(seen).toEqual(["transition@0", "transition@1"]);
    await ekman.close();
  });

  it("is not slowed by a sink that blocks", async () => {
    let blocked = 0;
    const ekman = new Ekman({
      entities: [orders],
      audit: [
        {
          name: "blocking",
          deliver: () => {
            const until = performance.now() + 25;
            while (performance.now() < until) {
              blocked += 1;
            }
          },
        },
      ],
    });

    const started = performance.now();
    await ekman.entities.orders.send("1", { type: "approve", actor: "amy" });

    expect(performance.now() - started).toBeLessThan(15);
    expect(blocked).toBe(0);
    await tick();
    expect(blocked).toBeGreaterThan(0);
    await ekman.close();
  });

  const delivering = (): void => undefined;

  it.each<[string, unknown]>([
    ["no name", { name: "", deliver: delivering }],
    ["no way to deliver", { name: "x" }],
    ["no attempts", { name: "x", deliver: delivering, maxAttempts: 0 }],
    [
      "a fractional attempt count",
      { name: "x", deliver: delivering, maxAttempts: 1.5 },
    ],
    ["a misspelled option", { name: "x", deliver: delivering, maxAttempt: 2 }],
  ])("refuses a sink with %s", (_what, sink) => {
    expect(() => new Ekman({ audit: [sink as never] })).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG" })
    );
  });
});

describe("typed escalation", () => {
  it("hands a typed handler an escalation it can act on without a cast", async () => {
    type State = "pending" | "overdue";
    type InvoiceTrigger = { type: "issue" } | TemporalTrigger<State>;

    let now = 1000;
    const seen: InvoiceTrigger[] = [];
    const invoices = defineEntity.withTriggers<InvoiceTrigger>()("invoices", {
      initial: "pending",
      states: {
        pending: (_invoice, trigger) => {
          seen.push(trigger);
          return trigger.type === DEFAULT_TEMPORAL_TRIGGER &&
            trigger.escalateTo !== undefined
            ? transitionTo(trigger.escalateTo)
            : stay();
        },
        overdue: () => stay(),
      },
      constraints: {
        temporal: [{ in: "pending", within: 50, escalateTo: "overdue" }],
      },
    });

    const ekman = new Ekman({ entities: [invoices], now: () => now });
    await ekman.entities.invoices.send("a", { type: "issue" });

    now += 100;
    expect(await ekman.sweep()).toBe(1);

    expect(ekman.entities.invoices.inspect("a")?.state).toBe("overdue");
    expect(seen.at(-1)).toMatchObject({
      type: "constraint.temporal",
      constraint: "temporal:pending:50",
      state: "pending",
      sinceMs: 100,
      escalateTo: "overdue",
    });
  });
});
