import { describe, expect, it } from "vitest";
import { analyze } from "../src/analysis";
import { defineEntity } from "../src/entity";
import { stay } from "../src/results";
import type { AnyEntityDefinition } from "../src/types";

// Unannotated on purpose: a Handler annotation widens the return and breaks narrow unions.
const noop = () => stay();

const orders = (
  allow?: Readonly<Record<string, readonly string[]>>
): AnyEntityDefinition =>
  defineEntity("orders", {
    initial: "pending",
    states: { pending: noop, approved: noop, shipped: noop, archived: noop },
    ...(allow === undefined ? {} : { constraints: { transitions: { allow } } }),
  });

describe("analyze", () => {
  it("reports an entity that declared no edges as unconstrained", () => {
    const analysis = analyze(orders());

    // Not "has no terminals and reaches everything" as a fact about the domain. Nothing was
    // declared, so there is nothing to say, and `constrained` is how a caller can tell.
    expect(analysis.constrained).toBe(false);
    expect(analysis.terminals).toEqual([]);
    expect(analysis.unreachable).toEqual([]);
  });

  it("names the states nothing leaves", () => {
    const analysis = analyze(
      orders({
        pending: ["approved"],
        approved: ["shipped"],
        shipped: [],
        archived: [],
      })
    );

    expect(analysis.constrained).toBe(true);
    expect(analysis.terminals).toEqual(["shipped", "archived"]);
  });

  it("names the states no declared path reaches from the initial one", () => {
    const analysis = analyze(
      orders({ pending: ["approved"], approved: ["shipped"], shipped: [] })
    );

    // "archived" has a handler and no way in. Worth knowing, not worth refusing: it is what
    // a half-wired state looks like on the way to being wired.
    expect(analysis.unreachable).toEqual(["archived"]);
  });

  it("counts a state reachable through a cycle", () => {
    const analysis = analyze(
      orders({
        pending: ["approved"],
        approved: ["pending", "shipped"],
        shipped: ["archived"],
        archived: [],
      })
    );

    expect(analysis.unreachable).toEqual([]);
    expect(analysis.terminals).toEqual(["archived"]);
  });

  it("freezes the lists as well as the report holding them", () => {
    const analysis = analyze(
      orders({ pending: ["approved"], approved: [], shipped: [], archived: [] })
    );

    // Freezing only the wrapper would stop the fields being swapped and leave the lists
    // editable, which is a weaker promise than the type makes.
    expect(Object.isFrozen(analysis)).toBe(true);
    expect(Object.isFrozen(analysis.terminals)).toBe(true);
    expect(Object.isFrozen(analysis.unreachable)).toBe(true);
  });
});
