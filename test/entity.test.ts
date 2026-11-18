import { describe, expect, expectTypeOf, it } from "vitest";
import { constraintsOf } from "../src/compiled.js";
import type { TemporalTrigger } from "../src/constraints.js";
import { DEFAULT_TEMPORAL_TRIGGER } from "../src/constraints.js";
import {
  defineEntity,
  resolveErrorHandler,
  statesFromEntries,
} from "../src/entity.js";
import type { EkmanError } from "../src/errors.js";
import { stay, transitionTo } from "../src/results.js";
import type { EntityDefinition, EntityHandles } from "../src/types.js";

// Deliberately unannotated. Annotating this `Handler` would widen its return to
// HandlerResult<string>, which is not assignable to a handler for a narrow state union,
// and the widening would look like a library bug rather than a test-helper bug.
const UNDECLARED_ESCALATION = /"constraint\.temporal".*declared triggers/s;

const INITIAL_VALUES = /initial values of entity "orders"/;
const UNKNOWN_POLICY = /unknown policy "ignore"/;

const noop = () => stay();

function selfReferring(): Record<string, unknown> {
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  return { loop };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as EkmanError).code;
  }
  throw new Error("expected a throw");
};

describe("defineEntity", () => {
  it("returns a validated definition", () => {
    const orders = defineEntity("orders", {
      initial: "pending",
      states: { pending: noop, approved: noop },
    });

    expect(orders.name).toBe("orders");
    expect(orders.initial).toBe("pending");
    expect([...orders.handlers.keys()]).toEqual(["pending", "approved"]);
    expect(orders.unknownPolicy).toBe("reject");
  });

  it("defaults the unknown policy to reject rather than to silence", () => {
    expect(
      defineEntity("orders", { initial: "a", states: { a: noop } })
        .unknownPolicy
    ).toBe("reject");
  });

  it("starts instances with empty values when none are declared", () => {
    expect(
      defineEntity("orders", { initial: "a", states: { a: noop } })
        .initialValues
    ).toEqual({});
  });

  it("starts instances with declared values, copied and frozen", () => {
    const declared = { region: "us-west-2", attempt: 0 };
    const orders = defineEntity("orders", {
      initial: "a",
      values: declared,
      states: { a: noop },
    });

    expect(orders.initialValues).toEqual({ region: "us-west-2", attempt: 0 });
    expect(Object.isFrozen(orders.initialValues)).toBe(true);

    // Copied, so mutating the caller's object cannot retroactively change the entity.
    declared.region = "eu-west-1";
    expect(orders.initialValues.region).toBe("us-west-2");
  });

  it("recognizes every trigger type when none are declared", () => {
    expect(
      defineEntity("orders", { initial: "a", states: { a: noop } }).triggers
    ).toBeNull();
  });

  it("records a declared trigger list", () => {
    const orders = defineEntity("orders", {
      initial: "a",
      triggers: ["approve", "cancel"],
      states: { a: noop },
    });
    expect([...(orders.triggers ?? [])]).toEqual(["approve", "cancel"]);
  });

  it("builds its own keys without a runtime", () => {
    expect(
      defineEntity("orders", { initial: "a", states: { a: noop } }).key("1")
    ).toBe("orders:1");
  });

  it("is frozen", () => {
    expect(
      Object.isFrozen(
        defineEntity("orders", { initial: "a", states: { a: noop } })
      )
    ).toBe(true);
  });
});

describe("defineEntity validation", () => {
  it("refuses a time bound whose escalation the entity would not recognize", () => {
    const define = () =>
      defineEntity("orders", {
        initial: "a",
        triggers: ["start"],
        states: { a: noop },
        constraints: { temporal: [{ in: "a", within: 10 }] },
      });

    expect(code(define)).toBe("INVALID_CONFIG");
    expect(define).toThrow(UNDECLARED_ESCALATION);
  });

  it("accepts an undeclared escalation type on a bound that only warns", () => {
    const definition = defineEntity("orders", {
      initial: "a",
      triggers: ["start"],
      states: { a: noop },
      constraints: { temporal: [{ in: "a", within: 10, policy: "warn" }] },
    });

    expect(constraintsOf(definition)?.temporal).toHaveLength(1);
  });

  it("rejects a missing initial state", () => {
    expect(
      code(() =>
        defineEntity("orders", {
          initial: undefined as unknown as "a",
          states: { a: noop },
        })
      )
    ).toBe("MISSING_INITIAL_STATE");
  });

  it("rejects an entity with no states at all", () => {
    expect(
      code(() =>
        defineEntity("orders", {
          initial: "a",
          states: {} as { a: typeof noop },
        })
      )
    ).toBe("MISSING_INITIAL_STATE");
  });

  it("rejects an initial state that has no handler", () => {
    expect(
      code(() =>
        defineEntity("orders", {
          initial: "shipped" as "pending",
          states: { pending: noop },
        })
      )
    ).toBe("INITIAL_STATE_NOT_IN_STATES");
  });

  it("names the declared states when the initial one is missing, so the fix is obvious", () => {
    try {
      defineEntity("orders", {
        initial: "shipped" as "pending",
        states: { pending: noop },
      });
    } catch (err) {
      expect((err as Error).message).toContain("pending");
    }
  });

  it.each([
    ["empty", ""],
    ["containing a separator", "or:ders"],
    ["containing a space", "my orders"],
    ["that is the parent directory", ".."],
    ["that is the current directory", "."],
    ["containing a control character", "or\u0001ders"],
    ["containing half of a surrogate pair", "orders\ud83d"],
    ["that is not a string", 42 as unknown as string],
  ])("rejects an entity name %s", (_why, name) => {
    expect(
      code(() => defineEntity(name, { initial: "a", states: { a: noop } }))
    ).toBe("INVALID_KEY");
  });

  it("rejects an empty trigger list instead of refusing every trigger at runtime", () => {
    expect(
      code(() =>
        defineEntity("orders", {
          initial: "a",
          triggers: [],
          states: { a: noop },
        })
      )
    ).toBe("UNKNOWN_TRIGGER");
  });

  it("refuses a constraint naming a state that has no handler", () => {
    expect(
      code(() =>
        defineEntity("orders", {
          initial: "a",
          states: { a: noop },
          constraints: { transitions: { allow: { a: ["b" as "a"] } } },
        })
      )
    ).toBe("INVALID_CONFIG");
  });

  it("carries compiled constraints on the definition", () => {
    const orders = defineEntity("orders", {
      initial: "a",
      states: { a: noop, b: noop },
      constraints: { transitions: { allow: { a: ["b"] } } },
    });

    // One structure, not two. The constraint reads the entity's own edges rather than a
    // copy of them, which is what stops the two disagreeing.
    expect(constraintsOf(orders)?.transitions?.states).toBe(orders.states);
    expect(orders.states.allows("a", "b")).toBe(true);
    expect(orders.states.allows("b", "a")).toBe(false);
  });

  it("gives every entity a graph, including one that declares no constraints", () => {
    const orders = defineEntity("orders", {
      initial: "a",
      states: { a: noop, b: noop },
    });

    expect(orders.constraints).toBeUndefined();
    expect(orders.states.names).toEqual(["a", "b"]);
    // No overlay means no edge was ever refused, which is not the same as no edges.
    expect(orders.states.hasEdges).toBe(false);
    expect(orders.states.allows("b", "a")).toBe(true);
  });

  it("leaves constraints undefined when none are declared", () => {
    const orders = defineEntity("orders", {
      initial: "a",
      states: { a: noop },
    });
    expect(orders.constraints).toBeUndefined();
  });

  it("compiles an entirely off constraint set away to nothing", () => {
    const orders = defineEntity("orders", {
      initial: "a",
      states: { a: noop, b: noop },
      constraints: {
        transitions: { policy: "off", allow: { a: ["b"] } },
        guards: [{ on: "b", policy: "off", check: () => false }],
      },
    });

    // Undefined rather than an empty structure, so "declared nothing" and "declared
    // everything off" are the same path at dispatch time.
    expect(orders.constraints).toBeUndefined();
    // The nodes survive a constraint that is off. The edges it declared do not, and
    // neither does any validation of them.
    expect(orders.states.names).toEqual(["a", "b"]);
    expect(orders.states.hasEdges).toBe(false);
  });

  it("does not validate a transition constraint that is off", () => {
    // An off constraint compiles away before its targets are looked at, which is what it
    // did before the graph existed. Building the overlay any earlier would change that.
    const orders = defineEntity("orders", {
      initial: "a",
      states: { a: noop, b: noop },
      constraints: {
        transitions: { policy: "off", allow: { a: ["nowhere" as "a"] } },
      },
    });

    expect(orders.constraints).toBeUndefined();
    expect(orders.states.hasEdges).toBe(false);
  });
});

describe("statesFromEntries", () => {
  it("builds a states record", () => {
    const states = statesFromEntries("orders", [
      ["pending", noop],
      ["approved", noop],
    ] as const);
    expect(Object.keys(states)).toEqual(["pending", "approved"]);
  });

  it("rejects a duplicate handler for one state", () => {
    expect(
      code(() =>
        statesFromEntries("orders", [
          ["pending", noop],
          ["pending", noop],
        ] as const)
      )
    ).toBe("DUPLICATE_STATE_HANDLER");
  });
});

describe("resolveErrorHandler", () => {
  // Unannotated for the same reason as `noop` above: an ErrorHandler annotation
  // widens the return type and stops it fitting a narrow state union.
  const handler = () => stay();

  it("matches on error name by default", () => {
    const orders = defineEntity("orders", {
      initial: "a",
      states: { a: noop },
      onError: { TypeError: handler },
    });
    expect(resolveErrorHandler(orders, new TypeError("x"))).toBe(handler);
    expect(resolveErrorHandler(orders, new RangeError("x"))).toBeUndefined();
  });

  it("falls back to the wildcard", () => {
    const orders = defineEntity("orders", {
      initial: "a",
      states: { a: noop },
      onError: { "*": handler },
    });
    expect(resolveErrorHandler(orders, new RangeError("x"))).toBe(handler);
  });

  it("prefers a specific classification over the wildcard", () => {
    const specific = () => stay();
    const orders = defineEntity("orders", {
      initial: "a",
      states: { a: noop },
      onError: { "*": handler, TypeError: specific },
    });
    expect(resolveErrorHandler(orders, new TypeError("x"))).toBe(specific);
  });

  it("honours a custom classifier", () => {
    const orders = defineEntity("orders", {
      initial: "a",
      states: { a: noop },
      classify: (err) =>
        err.message.startsWith("http:") ? "transport" : "other",
      onError: { transport: handler },
    });
    expect(resolveErrorHandler(orders, new Error("http: 503"))).toBe(handler);
    expect(resolveErrorHandler(orders, new Error("nope"))).toBeUndefined();
  });
});

describe("type inference", () => {
  it("infers the state union from the keys of states", () => {
    const orders = defineEntity("orders", {
      initial: "pending",
      states: { pending: noop, approved: noop },
    });
    expectTypeOf(orders.initial).toEqualTypeOf<"pending" | "approved">();
  });

  it("keeps the entity name as a literal, which is what types ekman.entities", () => {
    const orders = defineEntity("orders", {
      initial: "a",
      states: { a: noop },
    });
    expectTypeOf(orders.name).toEqualTypeOf<"orders">();
  });

  it("infers the values type from declared initial values", () => {
    const orders = defineEntity("orders", {
      initial: "a",
      values: { region: "us-west-2", attempt: 0 },
      states: {
        a: (instance) => {
          expectTypeOf(instance.values.region).toEqualTypeOf<string>();
          expectTypeOf(instance.values.attempt).toEqualTypeOf<number>();
          return stay();
        },
      },
    });
    expectTypeOf(orders.initialValues.region).toEqualTypeOf<string>();
  });

  it("takes all four type parameters from an annotation on the binding", () => {
    type State = "pending" | "approved";
    // biome-ignore lint/style/useConsistentTypeDefinitions: an interface has no implicit index signature, so it cannot satisfy the `Values` constraint
    type OrderValues = { by: string };
    type OrderTrigger = { type: "approve"; actor: string } | { type: "cancel" };

    const orders: EntityDefinition<"orders", State, OrderValues, OrderTrigger> =
      defineEntity("orders", {
        initial: "pending",
        values: { by: "" },
        states: {
          pending: (instance, trigger) => {
            expectTypeOf(trigger).toEqualTypeOf<OrderTrigger>();
            expectTypeOf(instance.values.by).toEqualTypeOf<string>();
            return trigger.type === "approve"
              ? transitionTo("approved", { by: trigger.actor })
              : stay();
          },
          approved: () => stay(),
        },
      });

    expectTypeOf(orders.initial).toEqualTypeOf<State>();
  });

  it("gives a typed entity a handle that sends only its union", () => {
    type OrderTrigger = { type: "approve"; actor: string } | { type: "cancel" };

    const orders: EntityDefinition<
      "orders",
      "pending",
      Record<string, unknown>,
      OrderTrigger
    > = defineEntity("orders", {
      initial: "pending",
      states: { pending: () => stay() },
    });

    type Send = EntityHandles<[typeof orders]>["orders"]["send"];
    expectTypeOf<Send>().parameter(1).toEqualTypeOf<OrderTrigger>();

    // @ts-expect-error "bogus" is not a type in the union
    const refused: Parameters<Send>[1] = { type: "bogus" };
    expect(refused.type).toBe("bogus");
  });
});

describe("typed triggers", () => {
  type OrderTrigger =
    | { type: "pay"; amount: number }
    | { type: "refund"; reason: string };

  it("takes the union first and infers the name, states and values", () => {
    const orders = defineEntity.withTriggers<OrderTrigger>()("orders", {
      initial: "pending",
      values: { total: 0 },
      states: {
        pending: (order, trigger) => {
          expectTypeOf(trigger).toEqualTypeOf<OrderTrigger>();
          expectTypeOf(order.values.total).toEqualTypeOf<number>();
          return trigger.type === "pay"
            ? transitionTo("paid", { total: trigger.amount })
            : stay();
        },
        paid: () => stay(),
      },
    });

    expectTypeOf(orders.name).toEqualTypeOf<"orders">();
    expectTypeOf(orders.initial).toEqualTypeOf<"pending" | "paid">();
    expectTypeOf(orders.initialValues.total).toEqualTypeOf<number>();
    expect(orders.states.names).toEqual(["pending", "paid"]);
  });

  it("gives the handle a send that takes only the union", () => {
    const orders = defineEntity.withTriggers<OrderTrigger>()("orders", {
      initial: "pending",
      states: { pending: () => stay() },
    });

    type Send = EntityHandles<[typeof orders]>["orders"]["send"];
    expectTypeOf<Send>().parameter(1).toEqualTypeOf<OrderTrigger>();

    // @ts-expect-error "bogus" is not a type in the union
    const refused: Parameters<Send>[1] = { type: "bogus" };
    expect(refused.type).toBe("bogus");
  });

  it("checks the triggers list against the union", () => {
    const orders = defineEntity.withTriggers<OrderTrigger>()("orders", {
      initial: "pending",
      // @ts-expect-error "typo" is not a type in the union
      triggers: ["pay", "typo"],
      states: { pending: () => stay() },
    });

    // The runtime takes the list as written. The refusal is the compiler's.
    expect(orders.triggers).toEqual(new Set(["pay", "typo"]));
  });

  it("leaves the triggers list as any strings when no union is given", () => {
    const orders = defineEntity("orders", {
      initial: "pending",
      triggers: ["pay", "anything"],
      states: { pending: noop },
    });

    expect(orders.triggers?.size).toBe(2);
  });

  it("narrows to the escalation once the union includes it", () => {
    type State = "pending" | "overdue";
    type Trigger = OrderTrigger | TemporalTrigger<State>;

    const orders = defineEntity.withTriggers<Trigger>()("orders", {
      initial: "pending",
      triggers: ["pay", "refund", DEFAULT_TEMPORAL_TRIGGER],
      states: {
        pending: (_order, trigger) => {
          if (trigger.type === DEFAULT_TEMPORAL_TRIGGER) {
            expectTypeOf(trigger.escalateTo).toEqualTypeOf<State | undefined>();
            expectTypeOf(trigger.sinceMs).toEqualTypeOf<number>();
            return transitionTo(trigger.escalateTo ?? "overdue");
          }
          expectTypeOf(trigger).toEqualTypeOf<OrderTrigger>();
          return stay();
        },
        overdue: () => stay(),
      },
      constraints: {
        temporal: [{ in: "pending", within: 10, escalateTo: "overdue" }],
      },
    });

    expect(orders.triggers?.has(DEFAULT_TEMPORAL_TRIGGER)).toBe(true);
  });

  it("types a bound's own trigger name", () => {
    type State = "pending" | "overdue";
    type Trigger = OrderTrigger | TemporalTrigger<State, "order.stuck">;

    const orders = defineEntity.withTriggers<Trigger>()("orders", {
      initial: "pending",
      triggers: ["pay", "refund", "order.stuck"],
      states: {
        pending: (_order, trigger) => {
          if (trigger.type === "order.stuck") {
            expectTypeOf(trigger.state).toEqualTypeOf<State>();
          }
          return stay();
        },
        overdue: () => stay(),
      },
      constraints: {
        temporal: [{ in: "pending", within: 10, trigger: "order.stuck" }],
      },
    });

    expect(orders.triggers?.has("order.stuck")).toBe(true);
  });
});

describe("initial values", () => {
  it("freezes them all the way down, on a copy", () => {
    const source = { nested: { n: 1 }, list: [{ id: 1 }] };
    const definition = defineEntity("orders", {
      initial: "a",
      values: source,
      states: { a: noop },
    });

    expect(Object.isFrozen(definition.initialValues.nested)).toBe(true);
    expect(Object.isFrozen(definition.initialValues.list[0])).toBe(true);
    expect(definition.initialValues.nested).not.toBe(source.nested);
  });

  it.each([
    ["a function", { fn: () => 1 }],
    ["a value JSON cannot represent", { big: 10n }],
    ["a Map, which a store would not bring back", { nested: new Map() }],
    ["a Date", { nested: { when: new Date(0) } }],
    ["binary data", { blob: new Uint8Array(2) }],
    ["a class instance", { list: [new (class Point {})()] }],
    ["a value that contains itself", selfReferring()],
    ["a number JSON would turn into null", { amount: Number.NaN }],
    ["an infinite number", { nested: { limit: Number.POSITIVE_INFINITY } }],
  ])("refuses %s at definition", (_what, values) => {
    const define = () =>
      defineEntity("orders", { initial: "a", values, states: { a: noop } });

    expect(code(define)).toBe("INVALID_CONFIG");
    expect(define).toThrow(INITIAL_VALUES);
  });
});

describe("unrecognized configuration", () => {
  const base = { initial: "a", states: { a: noop } } as const;

  it("refuses an unknown policy other than reject", () => {
    const define = () =>
      defineEntity("orders", { ...base, unknown: "ignore" } as never);

    expect(code(define)).toBe("INVALID_CONFIG");
    expect(define).toThrow(UNKNOWN_POLICY);
  });

  it.each([
    ["the entity", { ...base, intial: "a" }, '"intial"'],
    ["its constraints", { ...base, constraints: { guard: [] } }, '"guard"'],
    [
      "a transition graph",
      { ...base, constraints: { transitions: { allow: {}, polcy: "warn" } } },
      '"polcy"',
    ],
    [
      "a guard",
      {
        ...base,
        constraints: { guards: [{ on: "a", check: noop, polcy: 1 }] },
      },
      '"polcy"',
    ],
    [
      "an invariant",
      {
        ...base,
        constraints: { invariants: [{ check: noop, polcy: "warn" }] },
      },
      '"polcy"',
    ],
    [
      "a time bound",
      {
        ...base,
        constraints: { temporal: [{ in: "a", within: 5, escalte: "a" }] },
      },
      '"escalte"',
    ],
    ["its policy", { ...base, policy: { maxAttempt: 2 } }, '"maxAttempt"'],
    [
      "a state's policy",
      { initial: "a", states: { a: { handler: noop, timeout: 5 } } },
      '"timeout"',
    ],
    [
      "a backoff",
      {
        ...base,
        policy: { backoff: { kind: "fixed", delayMs: 1, baseMs: 1 } },
      },
      '"baseMs"',
    ],
  ])("refuses a misspelled option on %s", (_where, config, naming) => {
    const define = () => defineEntity("orders", config as never);

    expect(code(define)).toBe("INVALID_CONFIG");
    expect(define).toThrow(naming);
  });
});

describe("initial values a store would bring back unchanged", () => {
  it("accepts an absent optional value", () => {
    const definition = defineEntity("orders", {
      initial: "a",
      values: { receipt: undefined as string | undefined, total: 0 },
      states: { a: noop },
    });

    expect(definition.initialValues.receipt).toBeUndefined();
  });
});
