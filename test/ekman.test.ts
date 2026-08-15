import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { Ekman } from "../src/ekman";
import { defineEntity } from "../src/entity";
import { EkmanError } from "../src/errors";
import type { EkmanEvent, TransitionEvent } from "../src/events";
import { fail, stay, transitionTo } from "../src/results";
import type { TelemetryEvent } from "../src/telemetry";

const NON_NEGATIVE_INTEGER = /non-negative integer/;

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

    const [init] = transitions(ekman.history("orders:1"));
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

    const nullFrom = transitions(ekman.history("orders:1")).filter(
      (e) => e.from === null
    );
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

  it("reports nothing for a key never addressed", () => {
    const ekman = new Ekman({ entities: [orders] });
    expect(ekman.inspect("orders:never")).toBeUndefined();
    expect(ekman.history("orders:never")).toEqual([]);
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
    expect(transitions(ekman.history("orders:1"))).toHaveLength(1);
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

    const rejected = ekman
      .history("dead:1")
      .filter((e) => e.type === "rejected");
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

    const rejected = ekman
      .history("strict:1")
      .filter((e) => e.type === "rejected");
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

    expect(transitions(ekman.history("counter:1")).map((e) => e.seq)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
  });

  it("records the trigger as the cause, with a deterministic id", async () => {
    const ekman = new Ekman({ entities: [orders], now: steppingClock() });
    await ekman.send("orders:1", { type: "approve", actor: "amy" });

    const [init, approved] = transitions(ekman.history("orders:1"));
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
    expect(transitions(ekman.history("orders:1"))[1]?.cause.id).toBe("msg-991");
  });

  it("stamps events from the injected clock", async () => {
    const ekman = new Ekman({
      entities: [orders],
      now: steppingClock(1000, 1000),
    });
    await ekman.send("orders:1", { type: "approve", actor: "amy" });

    expect(transitions(ekman.history("orders:1")).map((e) => e.at)).toEqual([
      1000, 2000,
    ]);
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
    for (const event of ekman.entities.orders.history("1")) {
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

    expect(ekman.entities.orders.history("1")).toEqual(
      ekman.history("orders:1")
    );
    expect(ekman.entities.orders.history("1")).toHaveLength(2);
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
