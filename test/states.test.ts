import { describe, expect, it } from "vitest";
import { States, UNKNOWN_NODE } from "../src/states";

const NODES = ["pending", "approved", "shipped"] as const;

const SECOND_OVERLAY = /already have an edge overlay/;
const NO_SUCH_NODE = /no node "cancelled"/;

function statesOf(nodes: readonly string[] = NODES): States {
  return new States(nodes);
}

/** A graph with an overlay installed, which is the shape a declared constraint produces. */
function constrained(
  edges: readonly (readonly [string, readonly string[]])[],
  nodes: readonly string[] = NODES
): States {
  const states = statesOf(nodes);
  states.declareEdges(edges);
  return states;
}

describe("States", () => {
  it("takes its nodes from the declared states, in declaration order", () => {
    const states = statesOf();

    expect(states.names).toEqual(["pending", "approved", "shipped"]);
    expect(states.size).toBe(3);
  });

  it("interns every state to an id that round-trips back to its name", () => {
    const states = statesOf();

    for (const state of NODES) {
      expect(states.nameOf(states.idOf(state))).toBe(state);
    }
  });

  it("interns a state it does not declare to an id that can never index a row", () => {
    const states = statesOf();

    expect(states.has("cancelled")).toBe(false);
    expect(states.idOf("cancelled")).toBe(UNKNOWN_NODE);
    expect(UNKNOWN_NODE).toBeLessThan(0);
    expect(states.nameOf(UNKNOWN_NODE)).toBeUndefined();
  });

  it("dedupes repeated states rather than leaving a name nothing can address", () => {
    const states = statesOf(["pending", "pending", "shipped"]);

    expect(states.names).toEqual(["pending", "shipped"]);
    expect(states.nameOf(states.idOf("shipped"))).toBe("shipped");
  });

  it("is a legal graph with one state, because an entity that only stays is an entity", () => {
    const states = statesOf(["counting"]);

    expect(states.size).toBe(1);
    expect(states.hasEdges).toBe(false);
    expect(states.allows("counting", "counting")).toBe(true);
  });

  it("allows every transition when no overlay is declared, including a state to itself", () => {
    const states = statesOf();

    expect(states.hasEdges).toBe(false);
    expect(states.allows("pending", "shipped")).toBe(true);
    expect(states.allows("shipped", "pending")).toBe(true);
    expect(states.allows("pending", "pending")).toBe(true);
  });

  it("reports an unconstrained graph as complete rather than as empty", () => {
    const states = statesOf();

    expect(states.targetsOf("pending")).toEqual([
      "pending",
      "approved",
      "shipped",
    ]);
    expect(states.outDegree("pending")).toBe(3);
    expect(states.terminals()).toEqual([]);
    expect(states.unreachableFrom("pending")).toEqual([]);
  });

  it("has no targets for a state it does not declare, overlay or not", () => {
    expect(statesOf().targetsOf("cancelled")).toEqual([]);
    expect(
      constrained([["pending", ["approved"]]]).targetsOf("cancelled")
    ).toEqual([]);
  });

  it("makes only the declared edges legal, and in the declared direction", () => {
    const states = constrained([["pending", ["approved"]]]);

    expect(states.hasEdges).toBe(true);
    expect(states.allows("pending", "approved")).toBe(true);
    expect(states.allows("approved", "pending")).toBe(false);
    expect(states.allows("pending", "shipped")).toBe(false);
  });

  it("answers for a state it does not declare without being asked about it first", () => {
    const states = constrained([["pending", ["approved"]]]);

    expect(states.allows("cancelled", "approved")).toBe(false);
    expect(states.allows("pending", "cancelled")).toBe(false);
    expect(states.targetsOf("cancelled")).toEqual([]);
  });

  it("represents a self-edge", () => {
    const states = constrained([["pending", ["pending"]]]);

    expect(states.allows("pending", "pending")).toBe(true);
  });

  it("represents a cycle, and a walk over one terminates", () => {
    const states = constrained([
      ["pending", ["approved"]],
      ["approved", ["pending", "shipped"]],
    ]);

    expect(states.allows("pending", "approved")).toBe(true);
    expect(states.allows("approved", "pending")).toBe(true);
    expect([...states.reachableFrom("pending")].sort()).toEqual([
      "approved",
      "pending",
      "shipped",
    ]);
  });

  it("treats a state declared with no targets as a terminal", () => {
    const states = constrained([
      ["pending", ["shipped"]],
      ["shipped", []],
    ]);

    expect(states.outDegree("shipped")).toBe(0);
    expect(states.targetsOf("shipped")).toEqual([]);
    expect(states.allows("shipped", "pending")).toBe(false);
  });

  it("finds terminals among states with no row and states with an empty one alike", () => {
    const states = constrained([
      ["pending", ["approved", "shipped"]],
      ["shipped", []],
    ]);

    expect(states.terminals()).toEqual(["approved", "shipped"]);
  });

  it("keeps declared target order and dedupes, because a refusal message prints it", () => {
    const states = constrained([
      ["pending", ["shipped", "approved", "shipped"]],
    ]);

    expect(states.targetsOf("pending")).toEqual(["shipped", "approved"]);
    expect(states.outDegree("pending")).toBe(2);
  });

  it("reports nothing reachable from a state it does not declare", () => {
    const states = constrained([["pending", ["approved"]]]);

    expect([...states.reachableFrom("cancelled")]).toEqual([]);
  });

  it("does not count a state as reachable from itself without an edge back to it", () => {
    const states = constrained([["pending", ["approved"]]]);

    expect([...states.reachableFrom("pending")]).toEqual(["approved"]);
  });

  it("names the states no path from the initial one ever enters", () => {
    const states = constrained([["pending", ["approved"]]]);

    expect(states.unreachableFrom("pending")).toEqual(["shipped"]);
  });

  it("refuses a second overlay rather than letting one silently replace another", () => {
    const states = constrained([["pending", ["approved"]]]);

    expect(() => states.declareEdges([["approved", ["shipped"]]])).toThrow(
      SECOND_OVERLAY
    );
  });

  it("refuses an edge naming a node it does not have, from either end", () => {
    expect(() => constrained([["cancelled", ["approved"]]])).toThrow(
      NO_SUCH_NODE
    );
    expect(() => constrained([["pending", ["cancelled"]]])).toThrow(
      NO_SUCH_NODE
    );
  });
});
