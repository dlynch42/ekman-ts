import { describe, expect, it } from "vitest";
import { toDot, toMermaid } from "../src/diagram";
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
    states: { pending: noop, approved: noop, shipped: noop },
    ...(allow === undefined ? {} : { constraints: { transitions: { allow } } }),
  });

const declared = () =>
  orders({ pending: ["approved"], approved: ["shipped"], shipped: [] });

describe("toMermaid", () => {
  it("draws the initial state as the entry point", () => {
    expect(toMermaid(declared())).toContain("[*] --> pending");
  });

  it("draws one arrow per declared transition, in declared order", () => {
    expect(toMermaid(declared())).toBe(
      [
        "stateDiagram-v2",
        "  [*] --> pending",
        "  pending --> approved",
        "  approved --> shipped",
      ].join("\n")
    );
  });

  it("lists the states and says so when no transitions are declared", () => {
    const drawn = toMermaid(orders());

    // Every pair would be N-squared arrows saying nothing. The states plus a sentence say
    // the same thing and can be read.
    expect(drawn).toContain("  approved");
    expect(drawn).toContain("  shipped");
    expect(drawn).toContain("no transitions declared");
    expect(drawn).not.toContain("-->  approved");
  });

  it("aliases a state name that is not a legal mermaid id", () => {
    const shipping = defineEntity("shipping", {
      initial: "queued",
      states: { queued: noop, "rolled-back": noop },
      constraints: { transitions: { allow: { queued: ["rolled-back"] } } },
    });

    const drawn = toMermaid(shipping);

    expect(drawn).toContain('state "rolled-back" as s_rolled_back');
    expect(drawn).toContain("queued --> s_rolled_back");
  });

  it("keeps two state names apart when they sanitize to the same id", () => {
    const odd = defineEntity("odd", {
      initial: "rolled-back",
      states: { "rolled-back": noop, "rolled back": noop },
      constraints: {
        transitions: { allow: { "rolled-back": ["rolled back"] } },
      },
    });

    const drawn = toMermaid(odd);

    expect(drawn).toContain('state "rolled-back" as s_rolled_back');
    expect(drawn).toContain('state "rolled back" as s_rolled_back_2');
    expect(drawn).toContain("s_rolled_back --> s_rolled_back_2");
  });

  it("draws an observed transition naming a state the entity no longer declares", () => {
    const drawn = toMermaid(declared(), {
      observed: new Map([["retired-state", new Set(["pending"])]]),
    });

    // A stream outlives a rename, so an observed edge can name something the entity has
    // since dropped. Showing it is the point: it is exactly what the operator needs to see.
    expect(drawn).toContain("s_retired_state --> pending : observed");
  });

  it("marks an observed transition that was never declared", () => {
    const drawn = toMermaid(declared(), {
      observed: new Map([["shipped", new Set(["pending"])]]),
    });

    expect(drawn).toContain("shipped --> pending : observed");
  });

  it("does not draw an observed transition twice when it was declared", () => {
    const drawn = toMermaid(declared(), {
      observed: new Map([["pending", new Set(["approved"])]]),
    });

    expect(drawn).not.toContain("observed");
    expect(
      drawn.split("\n").filter((line) => line.includes("pending --> approved"))
    ).toHaveLength(1);
  });

  it("marks every observed transition when nothing was declared", () => {
    const drawn = toMermaid(orders(), {
      observed: new Map([["pending", new Set(["shipped"])]]),
    });

    // Nothing was declared, so nothing observed can be confirmed by it. Calling the edge
    // declared here would report agreement with a declaration that does not exist.
    expect(drawn).toContain("pending --> shipped : observed");
  });
});

describe("toDot", () => {
  it("names the graph after the entity and points at the initial state", () => {
    const drawn = toDot(declared());

    expect(drawn).toContain('digraph "orders" {');
    expect(drawn).toContain('__start -> "pending";');
    expect(drawn.endsWith("}")).toBe(true);
  });

  it("draws every state, including one no declared transition reaches", () => {
    const drawn = toDot(orders({ pending: ["approved"], approved: [] }));

    expect(drawn).toContain('"shipped";');
  });

  it("dashes an observed transition that was never declared", () => {
    const drawn = toDot(declared(), {
      observed: new Map([["shipped", new Set(["pending"])]]),
    });

    expect(drawn).toContain(
      '"shipped" -> "pending" [style=dashed, label="observed"];'
    );
  });

  it("says so when no transitions are declared", () => {
    expect(toDot(orders())).toContain("no transitions declared");
  });

  it("escapes a quote in a state name rather than emitting broken dot", () => {
    const odd = defineEntity("odd", {
      initial: 'say "hi"',
      states: { 'say "hi"': noop },
    });

    expect(toDot(odd)).toContain('"say \\"hi\\"";');
  });
});
