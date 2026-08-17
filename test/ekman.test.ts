import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { Ekman } from "../src/ekman";
import { defineEntity } from "../src/entity";
import { EkmanError } from "../src/errors";
import type { EkmanEvent, TransitionEvent } from "../src/events";
import { fail, stay, transitionTo } from "../src/results";
import type { TelemetryEvent } from "../src/telemetry";

const NON_NEGATIVE_INTEGER = /non-negative integer/;
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
    const [reported] = onUnhandled.mock.calls[0] ?? [];
    expect((reported as EkmanError).code).toBe("HANDLER_FAILED");
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
      expect(spy.mock.calls[0]?.[0]).toContain("[ekman]");
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

/** A clock frozen until something moves it, which is what elapsed time needs. */
const frozenClock = (start = 0) => {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
};

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
      states: { waiting: () => stay(), other: () => stay() },
      // The entity recognizes only this one trigger type, so its own escalation is
      // refused on arrival. Contrived, but it is the same shape as the realistic case:
      // an instance stranded in a state whose handler was removed.
      triggers: ["begin"],
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

    expect((unhandled[0] as EkmanError).code).toBe("UNKNOWN_TRIGGER");
    expect(events.find((e) => e.type === "constraint.escalated")).toMatchObject(
      { delivered: false, constraint: "waited" }
    );
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
