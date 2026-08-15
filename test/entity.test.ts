import { describe, expect, expectTypeOf, it } from "vitest"
import { defineEntity, resolveErrorHandler, statesFromEntries } from "../src/entity.js"
import type { EkmanError } from "../src/errors.js"
import { stay, transitionTo } from "../src/results.js"
import type { EntityDefinition } from "../src/types.js"

// Deliberately unannotated. Annotating this `Handler` would widen its return to
// HandlerResult<string>, which is not assignable to a handler for a narrow state union,
// and the widening would look like a library bug rather than a test-helper bug.
const noop = () => stay()

const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (err) {
    return (err as EkmanError).code
  }
  throw new Error("expected a throw")
}

describe("defineEntity", () => {
  it("returns a validated definition", () => {
    const orders = defineEntity("orders", {
      initial: "pending",
      states: { pending: noop, approved: noop },
    })

    expect(orders.name).toBe("orders")
    expect(orders.initial).toBe("pending")
    expect([...orders.states.keys()]).toEqual(["pending", "approved"])
    expect(orders.unknownPolicy).toBe("reject")
  })

  it("defaults the unknown policy to reject rather than to silence", () => {
    expect(defineEntity("orders", { initial: "a", states: { a: noop } }).unknownPolicy).toBe("reject")
  })

  it("starts instances with empty values when none are declared", () => {
    expect(defineEntity("orders", { initial: "a", states: { a: noop } }).initialValues).toEqual({})
  })

  it("starts instances with declared values, copied and frozen", () => {
    const declared = { region: "us-west-2", attempt: 0 }
    const orders = defineEntity("orders", { initial: "a", values: declared, states: { a: noop } })

    expect(orders.initialValues).toEqual({ region: "us-west-2", attempt: 0 })
    expect(Object.isFrozen(orders.initialValues)).toBe(true)

    // Copied, so mutating the caller's object cannot retroactively change the entity.
    declared.region = "eu-west-1"
    expect(orders.initialValues.region).toBe("us-west-2")
  })

  it("recognizes every trigger type when none are declared", () => {
    expect(defineEntity("orders", { initial: "a", states: { a: noop } }).triggers).toBeNull()
  })

  it("records a declared trigger list", () => {
    const orders = defineEntity("orders", {
      initial: "a",
      triggers: ["approve", "cancel"],
      states: { a: noop },
    })
    expect([...orders.triggers!]).toEqual(["approve", "cancel"])
  })

  it("builds its own keys without a runtime", () => {
    expect(defineEntity("orders", { initial: "a", states: { a: noop } }).key("1")).toBe("orders:1")
  })

  it("is frozen", () => {
    expect(Object.isFrozen(defineEntity("orders", { initial: "a", states: { a: noop } }))).toBe(true)
  })
})

describe("defineEntity validation", () => {
  it("rejects a missing initial state", () => {
    expect(
      code(() => defineEntity("orders", { initial: undefined as unknown as "a", states: { a: noop } })),
    ).toBe("MISSING_INITIAL_STATE")
  })

  it("rejects an entity with no states at all", () => {
    expect(code(() => defineEntity("orders", { initial: "a", states: {} as { a: typeof noop } }))).toBe(
      "MISSING_INITIAL_STATE",
    )
  })

  it("rejects an initial state that has no handler", () => {
    expect(
      code(() =>
        defineEntity("orders", {
          initial: "shipped" as "pending",
          states: { pending: noop },
        }),
      ),
    ).toBe("INITIAL_STATE_NOT_IN_STATES")
  })

  it("names the declared states when the initial one is missing, so the fix is obvious", () => {
    try {
      defineEntity("orders", { initial: "shipped" as "pending", states: { pending: noop } })
    } catch (err) {
      expect((err as Error).message).toContain("pending")
    }
  })

  it.each([
    ["empty", ""],
    ["containing a separator", "or:ders"],
    ["containing a space", "my orders"],
  ])("rejects an entity name %s", (_why, name) => {
    expect(code(() => defineEntity(name, { initial: "a", states: { a: noop } }))).toBe("INVALID_KEY")
  })

  it("rejects an empty trigger list instead of refusing every trigger at runtime", () => {
    expect(
      code(() => defineEntity("orders", { initial: "a", triggers: [], states: { a: noop } })),
    ).toBe("UNKNOWN_TRIGGER")
  })

  it("refuses constraints rather than ignoring them", () => {
    expect(
      code(() =>
        defineEntity("orders", { initial: "a", states: { a: noop }, constraints: { graph: {} } }),
      ),
    ).toBe("NOT_IMPLEMENTED")
  })
})

describe("statesFromEntries", () => {
  it("builds a states record", () => {
    const states = statesFromEntries("orders", [
      ["pending", noop],
      ["approved", noop],
    ] as const)
    expect(Object.keys(states)).toEqual(["pending", "approved"])
  })

  it("rejects a duplicate handler for one state", () => {
    expect(
      code(() =>
        statesFromEntries("orders", [
          ["pending", noop],
          ["pending", noop],
        ] as const),
      ),
    ).toBe("DUPLICATE_STATE_HANDLER")
  })
})

describe("resolveErrorHandler", () => {
  // Unannotated for the same reason as `noop` above: an ErrorHandler annotation
  // widens the return type and stops it fitting a narrow state union.
  const handler = () => stay()

  it("matches on error name by default", () => {
    const orders = defineEntity("orders", {
      initial: "a",
      states: { a: noop },
      onError: { TypeError: handler },
    })
    expect(resolveErrorHandler(orders, new TypeError("x"))).toBe(handler)
    expect(resolveErrorHandler(orders, new RangeError("x"))).toBeUndefined()
  })

  it("falls back to the wildcard", () => {
    const orders = defineEntity("orders", {
      initial: "a",
      states: { a: noop },
      onError: { "*": handler },
    })
    expect(resolveErrorHandler(orders, new RangeError("x"))).toBe(handler)
  })

  it("prefers a specific classification over the wildcard", () => {
    const specific = () => stay()
    const orders = defineEntity("orders", {
      initial: "a",
      states: { a: noop },
      onError: { "*": handler, TypeError: specific },
    })
    expect(resolveErrorHandler(orders, new TypeError("x"))).toBe(specific)
  })

  it("honours a custom classifier", () => {
    const orders = defineEntity("orders", {
      initial: "a",
      states: { a: noop },
      classify: (err) => (err.message.startsWith("http:") ? "transport" : "other"),
      onError: { transport: handler },
    })
    expect(resolveErrorHandler(orders, new Error("http: 503"))).toBe(handler)
    expect(resolveErrorHandler(orders, new Error("nope"))).toBeUndefined()
  })
})

describe("type inference", () => {
  it("infers the state union from the keys of states", () => {
    const orders = defineEntity("orders", {
      initial: "pending",
      states: { pending: noop, approved: noop },
    })
    expectTypeOf(orders.initial).toEqualTypeOf<"pending" | "approved">()
  })

  it("keeps the entity name as a literal, which is what types ekman.entities", () => {
    const orders = defineEntity("orders", { initial: "a", states: { a: noop } })
    expectTypeOf(orders.name).toEqualTypeOf<"orders">()
  })

  it("infers the values type from declared initial values", () => {
    const orders = defineEntity("orders", {
      initial: "a",
      values: { region: "us-west-2", attempt: 0 },
      states: {
        a: (instance) => {
          expectTypeOf(instance.values.region).toEqualTypeOf<string>()
          expectTypeOf(instance.values.attempt).toEqualTypeOf<number>()
          return stay()
        },
      },
    })
    expectTypeOf(orders.initialValues.region).toEqualTypeOf<string>()
  })

  it("takes all four type parameters from an annotation on the binding", () => {
    type State = "pending" | "approved"
    type OrderValues = { by: string }
    type OrderTrigger = { type: "approve"; actor: string } | { type: "cancel" }

    const orders: EntityDefinition<"orders", State, OrderValues, OrderTrigger> = defineEntity(
      "orders",
      {
        initial: "pending",
        values: { by: "" },
        states: {
          pending: (instance, trigger) => {
            expectTypeOf(trigger).toEqualTypeOf<OrderTrigger>()
            expectTypeOf(instance.values.by).toEqualTypeOf<string>()
            return trigger.type === "approve"
              ? transitionTo("approved", { by: trigger.actor })
              : stay()
          },
          approved: () => stay(),
        },
      },
    )

    expectTypeOf(orders.initial).toEqualTypeOf<State>()
  })
})
