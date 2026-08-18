import { describe, expect, it } from "vitest";
import type { ConstraintsConfig } from "../src/constraints";
import {
  checkConstraints,
  compileConstraints,
  DEFAULT_TEMPORAL_TRIGGER,
  rejection,
  violationError,
} from "../src/constraints";
import { isEkmanError } from "../src/errors";
import { States } from "../src/states";
import type { InstanceSnapshot, Trigger } from "../src/types";

const STATES = ["pending", "approved", "shipped"] as const;

const NO_WAY_OUT = /declared targets are: \(none\)/;

function compile(
  config: ConstraintsConfig,
  states: readonly string[] = STATES
) {
  return compileConstraints("orders", config, new States(states));
}

/** The error code of a throwing call, or "no-throw" if it did not throw. */
function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return isEkmanError(error) ? error.code : "not-an-ekman-error";
  }
  return "no-throw";
}

const snapshot: InstanceSnapshot = Object.freeze({
  key: "orders:1",
  entity: "orders",
  state: "pending",
  values: Object.freeze({ total: 5 }),
  seq: 1,
});

const trigger: Trigger = { type: "approve", id: "t1" };

describe("compiling constraints", () => {
  it.each([
    ["an empty graph", {}],
    ["a missing graph", undefined],
  ])("refuses a transition constraint declaring %s", (_why, allow) => {
    // Not the same as `off`. Declaring an empty graph would refuse every transition, which
    // is far more likely a mistake than an intention.
    expect(
      code(() =>
        compile({
          transitions: {
            allow: allow as Record<string, readonly string[]>,
          },
        })
      )
    ).toBe("INVALID_CONFIG");
  });

  it("refuses a transition mapped to something that is not a list of states", () => {
    expect(
      code(() =>
        compile({
          transitions: {
            allow: { pending: "approved" as unknown as string[] },
          },
        })
      )
    ).toBe("INVALID_CONFIG");
  });

  it("refuses a target state that has no handler", () => {
    expect(
      code(() => compile({ transitions: { allow: { pending: ["gone"] } } }))
    ).toBe("INVALID_CONFIG");
  });

  it("refuses a violation policy it does not recognize", () => {
    expect(
      code(() =>
        compile({
          transitions: {
            policy: "maybe" as "warn",
            allow: { pending: ["approved"] },
          },
        })
      )
    ).toBe("INVALID_CONFIG");
  });

  it("refuses a guard with no check function", () => {
    expect(
      code(() =>
        compile({
          guards: [{ on: "approved", check: undefined as unknown as never }],
        })
      )
    ).toBe("INVALID_CONFIG");
  });

  it("refuses an invariant scoped to a state that has no handler", () => {
    expect(
      code(() => compile({ invariants: [{ in: ["gone"], check: () => true }] }))
    ).toBe("INVALID_CONFIG");
  });

  it("refuses a temporal bound that is not a positive duration", () => {
    expect(
      code(() => compile({ temporal: [{ in: "pending", within: 0 }] }))
    ).toBe("INVALID_CONFIG");
    expect(
      code(() => compile({ temporal: [{ in: "pending", within: Number.NaN }] }))
    ).toBe("INVALID_CONFIG");
  });

  it("refuses a temporal escalation target that has no handler", () => {
    expect(
      code(() =>
        compile({
          temporal: [{ in: "pending", within: 10, escalateTo: "gone" }],
        })
      )
    ).toBe("INVALID_CONFIG");
  });

  it("refuses a temporal escalation the declared transitions would reject", () => {
    // The escalation arrives as a trigger while the instance is still in "pending", so a
    // handler could only move to a state "pending" declares. "shipped" is not one.
    expect(
      code(() =>
        compile({
          transitions: { allow: { pending: ["approved"] } },
          temporal: [{ in: "pending", within: 10, escalateTo: "shipped" }],
        })
      )
    ).toBe("INVALID_CONFIG");
  });

  it("says so plainly when the escalating state declares no way out at all", () => {
    expect(() =>
      compile({
        transitions: { allow: { approved: ["shipped"] } },
        temporal: [{ in: "pending", within: 10, escalateTo: "shipped" }],
      })
    ).toThrow(NO_WAY_OUT);
  });

  it("allows a temporal escalation to a declared target", () => {
    expect(
      compile({
        transitions: { allow: { pending: ["approved"] } },
        temporal: [{ in: "pending", within: 10, escalateTo: "approved" }],
      })?.temporal
    ).toHaveLength(1);
  });

  it("leaves an escalation alone when no transitions are declared", () => {
    // Without an overlay every transition is legal, so there is nothing to refuse and no
    // opinion to have about where an escalation points.
    expect(
      compile({
        temporal: [{ in: "pending", within: 10, escalateTo: "shipped" }],
      })?.temporal
    ).toHaveLength(1);
  });

  it("derives a name for every constraint that does not declare one", () => {
    const compiled = compile({
      guards: [{ on: "approved", check: () => true }],
      invariants: [
        { check: () => true },
        { in: ["pending", "approved"], check: () => true },
      ],
      temporal: [{ in: "pending", within: 10 }],
    });

    expect(compiled?.guards[0]?.name).toBe("guard:approved");
    expect(compiled?.invariants[0]?.name).toBe("invariant:*");
    expect(compiled?.invariants[1]?.name).toBe("invariant:pending|approved");
    expect(compiled?.temporal[0]?.name).toBe("temporal:pending");
    expect(compiled?.temporal[0]?.trigger).toBe(DEFAULT_TEMPORAL_TRIGGER);
  });

  it("groups several temporal constraints watching one state", () => {
    const compiled = compile({
      temporal: [
        { name: "warn-at", in: "pending", within: 10 },
        { name: "page-at", in: "pending", within: 100 },
        { name: "other", in: "approved", within: 10 },
      ],
    });

    expect(
      compiled?.temporalByState.get("pending")?.map((c) => c.name)
    ).toEqual(["warn-at", "page-at"]);
    expect(compiled?.temporalByState.get("approved")).toHaveLength(1);
  });

  it("compiles an off constraint away entirely", () => {
    expect(
      compile({
        guards: [{ on: "approved", policy: "off", check: () => false }],
        invariants: [{ policy: "off", check: () => false }],
        temporal: [{ in: "pending", within: 10, policy: "off" }],
      })
    ).toBeUndefined();
  });
});

describe("checking constraints", () => {
  const transitioning = {
    instance: snapshot,
    trigger,
    // Interned the same way the runtime interns it, rather than written as a literal, so
    // this follows STATES if STATES changes.
    fromStateId: new States(STATES).idOf(snapshot.state),
    transitioning: true,
    mutatingValues: false,
  };

  it("returns nothing when there are no constraints at all", () => {
    expect(
      checkConstraints(undefined, {
        ...transitioning,
        next: { state: "approved", values: {} },
      })
    ).toEqual([]);
  });

  it("reports a transition that is not in the graph", () => {
    const compiled = compile({
      transitions: { allow: { pending: ["approved"] } },
    });

    const violations = checkConstraints(compiled, {
      ...transitioning,
      next: { state: "shipped", values: {} },
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe("transition");
    expect(violations[0]?.reason).toContain("approved");
  });

  it("names the empty set when the source state declares no targets at all", () => {
    const compiled = compile({
      transitions: { allow: { approved: ["shipped"] } },
    });

    const violations = checkConstraints(compiled, {
      ...transitioning,
      next: { state: "approved", values: {} },
    });

    expect(violations[0]?.reason).toContain("(none)");
  });

  it("returns one shared empty result for every commit that violates nothing", () => {
    const compiled = compile({
      transitions: { allow: { pending: ["approved"] } },
      guards: [{ on: "approved", check: () => true }],
    });

    const clean = { ...transitioning, next: { state: "approved", values: {} } };

    // Identity, not equality. A commit that violates nothing is nearly every commit, and
    // handing each one a fresh array is an allocation per commit for an empty answer.
    expect(checkConstraints(compiled, clean)).toHaveLength(0);
    expect(checkConstraints(compiled, clean)).toBe(
      checkConstraints(compiled, clean)
    );
  });

  it("stops at the first rejecting violation but keeps the warnings before it", () => {
    const compiled = compile({
      transitions: { policy: "warn", allow: { pending: ["approved"] } },
      guards: [
        { name: "first", on: "shipped", check: () => "no" },
        { name: "second", on: "shipped", check: () => "also no" },
      ],
    });

    const violations = checkConstraints(compiled, {
      ...transitioning,
      next: { state: "shipped", values: {} },
    });

    expect(violations.map((v) => v.name)).toEqual(["transitions", "first"]);
    expect(rejection(violations)?.name).toBe("first");
  });

  it("keeps walking the guards after one that only warns", () => {
    const compiled = compile({
      guards: [
        { name: "soft", on: "shipped", policy: "warn", check: () => "noted" },
        { name: "hard", on: "shipped", check: () => "no" },
      ],
    });

    const violations = checkConstraints(compiled, {
      ...transitioning,
      next: { state: "shipped", values: {} },
    });

    expect(violations.map((v) => v.name)).toEqual(["soft", "hard"]);
    expect(rejection(violations)?.name).toBe("hard");
  });

  it("skips a guard whose target state is not the one being entered", () => {
    const compiled = compile({
      guards: [{ name: "elsewhere", on: "shipped", check: () => false }],
    });

    expect(
      checkConstraints(compiled, {
        ...transitioning,
        next: { state: "approved", values: {} },
      })
    ).toEqual([]);
  });

  it("skips guards entirely on a result that is not a transition", () => {
    const compiled = compile({
      guards: [{ name: "any", on: "pending", check: () => false }],
    });

    expect(
      checkConstraints(compiled, {
        instance: snapshot,
        trigger,
        fromStateId: transitioning.fromStateId,
        transitioning: false,
        mutatingValues: true,
        next: { state: "pending", values: {} },
      })
    ).toEqual([]);
  });

  it("treats a check that throws as a violation carrying its message", () => {
    const compiled = compile({
      guards: [
        {
          name: "broken",
          on: "approved",
          check: () => {
            throw new Error("lookup failed");
          },
        },
      ],
    });

    const violations = checkConstraints(compiled, {
      ...transitioning,
      next: { state: "approved", values: {} },
    });

    expect(violations[0]?.reason).toContain("lookup failed");
  });

  it("falls back to a generic reason when a check just answers false", () => {
    const compiled = compile({
      guards: [{ name: "terse", on: "approved", check: () => false }],
    });

    const violations = checkConstraints(compiled, {
      ...transitioning,
      next: { state: "approved", values: {} },
    });

    expect(violations[0]?.reason).toBe("the check did not hold");
  });

  it("passes the proposed commit, the current instance, and the trigger to a check", () => {
    const seen: unknown[] = [];
    const compiled = compile({
      guards: [
        {
          on: "approved",
          check: (next, instance, incoming) => {
            seen.push(next, instance, incoming);
            return true;
          },
        },
      ],
    });

    checkConstraints(compiled, {
      ...transitioning,
      next: { state: "approved", values: { total: 9 } },
    });

    expect(seen[0]).toEqual({ state: "approved", values: { total: 9 } });
    expect(seen[1]).toBe(snapshot);
    expect(seen[2]).toBe(trigger);
  });

  it("checks an unscoped invariant in every state", () => {
    const compiled = compile({ invariants: [{ check: () => "never ok" }] });

    expect(
      checkConstraints(compiled, {
        ...transitioning,
        next: { state: "approved", values: {} },
      })
    ).toHaveLength(1);
  });

  it("skips an invariant on a result that changes neither state nor values", () => {
    const compiled = compile({ invariants: [{ check: () => false }] });

    expect(
      checkConstraints(compiled, {
        instance: snapshot,
        trigger,
        fromStateId: transitioning.fromStateId,
        transitioning: false,
        mutatingValues: false,
        next: { state: "pending", values: {} },
      })
    ).toEqual([]);
  });

  it("stops at the first rejecting invariant", () => {
    const compiled = compile({
      invariants: [
        { name: "one", policy: "warn", check: () => false },
        { name: "two", check: () => false },
        { name: "three", check: () => false },
      ],
    });

    const violations = checkConstraints(compiled, {
      ...transitioning,
      next: { state: "approved", values: {} },
    });

    expect(violations.map((v) => v.name)).toEqual(["one", "two"]);
  });

  it("returns no rejection when everything found was a warning", () => {
    const compiled = compile({
      invariants: [{ name: "soft", policy: "warn", check: () => false }],
    });

    const violations = checkConstraints(compiled, {
      ...transitioning,
      next: { state: "approved", values: {} },
    });

    expect(rejection(violations)).toBeUndefined();
  });
});

describe("the error a refused result carries", () => {
  it("classifies as ConstraintViolation so an error handler can key on it", () => {
    const error = violationError(
      {
        kind: "guard",
        name: "region-required",
        policy: "reject",
        reason: "no region",
      },
      "orders:1"
    );

    expect(error.name).toBe("ConstraintViolation");
    expect(error.code).toBe("CONSTRAINT_VIOLATED");
    expect(error.kind).toBe("guard");
    expect(error.constraint).toBe("region-required");
    expect(error.key).toBe("orders:1");
    expect(error.message).toContain("region-required");
    expect(error.message).toContain("no region");
  });
});
