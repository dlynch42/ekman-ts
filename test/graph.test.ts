import { describe, expect, it } from "vitest";
import { StateGraph, UNKNOWN_STATE } from "../src/graph";

const NODES = ["pending", "approved", "shipped"] as const;

const SECOND_OVERLAY = /already has an edge overlay/;
const NO_SUCH_STATE = /no state "cancelled"/;

function graphOf(states: readonly string[] = NODES): StateGraph {
  return new StateGraph(states);
}

/** A graph with an overlay installed, which is the shape a declared constraint produces. */
function constrained(
  edges: readonly (readonly [string, readonly string[]])[],
  states: readonly string[] = NODES
): StateGraph {
  const graph = graphOf(states);
  graph.declareEdges(edges);
  return graph;
}

describe("StateGraph", () => {
  it("takes its nodes from the declared states, in declaration order", () => {
    const graph = graphOf();

    expect(graph.states).toEqual(["pending", "approved", "shipped"]);
    expect(graph.size).toBe(3);
  });

  it("interns every state to an id that round-trips back to its name", () => {
    const graph = graphOf();

    for (const state of NODES) {
      expect(graph.nameOf(graph.idOf(state))).toBe(state);
    }
  });

  it("interns a state it does not declare to an id that can never index a row", () => {
    const graph = graphOf();

    expect(graph.has("cancelled")).toBe(false);
    expect(graph.idOf("cancelled")).toBe(UNKNOWN_STATE);
    expect(UNKNOWN_STATE).toBeLessThan(0);
    expect(graph.nameOf(UNKNOWN_STATE)).toBeUndefined();
  });

  it("dedupes repeated states rather than leaving a name nothing can address", () => {
    const graph = graphOf(["pending", "pending", "shipped"]);

    expect(graph.states).toEqual(["pending", "shipped"]);
    expect(graph.nameOf(graph.idOf("shipped"))).toBe("shipped");
  });

  it("is a legal graph with one state, because an entity that only stays is an entity", () => {
    const graph = graphOf(["counting"]);

    expect(graph.size).toBe(1);
    expect(graph.hasEdges).toBe(false);
    expect(graph.allows("counting", "counting")).toBe(true);
  });

  it("allows every transition when no overlay is declared, including a state to itself", () => {
    const graph = graphOf();

    expect(graph.hasEdges).toBe(false);
    expect(graph.allows("pending", "shipped")).toBe(true);
    expect(graph.allows("shipped", "pending")).toBe(true);
    expect(graph.allows("pending", "pending")).toBe(true);
  });

  it("reports an unconstrained graph as complete rather than as empty", () => {
    const graph = graphOf();

    expect(graph.targetsOf("pending")).toEqual([
      "pending",
      "approved",
      "shipped",
    ]);
    expect(graph.outDegree("pending")).toBe(3);
    expect(graph.terminals()).toEqual([]);
    expect(graph.unreachableFrom("pending")).toEqual([]);
  });

  it("makes only the declared edges legal, and in the declared direction", () => {
    const graph = constrained([["pending", ["approved"]]]);

    expect(graph.hasEdges).toBe(true);
    expect(graph.allows("pending", "approved")).toBe(true);
    expect(graph.allows("approved", "pending")).toBe(false);
    expect(graph.allows("pending", "shipped")).toBe(false);
  });

  it("answers for a state it does not declare without being asked about it first", () => {
    const graph = constrained([["pending", ["approved"]]]);

    expect(graph.allows("cancelled", "approved")).toBe(false);
    expect(graph.allows("pending", "cancelled")).toBe(false);
    expect(graph.targetsOf("cancelled")).toEqual([]);
  });

  it("represents a self-edge", () => {
    const graph = constrained([["pending", ["pending"]]]);

    expect(graph.allows("pending", "pending")).toBe(true);
  });

  it("represents a cycle, and a walk over one terminates", () => {
    const graph = constrained([
      ["pending", ["approved"]],
      ["approved", ["pending", "shipped"]],
    ]);

    expect(graph.allows("pending", "approved")).toBe(true);
    expect(graph.allows("approved", "pending")).toBe(true);
    expect([...graph.reachableFrom("pending")].sort()).toEqual([
      "approved",
      "pending",
      "shipped",
    ]);
  });

  it("treats a state declared with no targets as a terminal", () => {
    const graph = constrained([
      ["pending", ["shipped"]],
      ["shipped", []],
    ]);

    expect(graph.outDegree("shipped")).toBe(0);
    expect(graph.targetsOf("shipped")).toEqual([]);
    expect(graph.allows("shipped", "pending")).toBe(false);
  });

  it("finds terminals among states with no row and states with an empty one alike", () => {
    const graph = constrained([
      ["pending", ["approved", "shipped"]],
      ["shipped", []],
    ]);

    expect(graph.terminals()).toEqual(["approved", "shipped"]);
  });

  it("keeps declared target order and dedupes, because a refusal message prints it", () => {
    const graph = constrained([
      ["pending", ["shipped", "approved", "shipped"]],
    ]);

    expect(graph.targetsOf("pending")).toEqual(["shipped", "approved"]);
    expect(graph.outDegree("pending")).toBe(2);
  });

  it("reports nothing reachable from a state it does not declare", () => {
    const graph = constrained([["pending", ["approved"]]]);

    expect([...graph.reachableFrom("cancelled")]).toEqual([]);
  });

  it("does not count a state as reachable from itself without an edge back to it", () => {
    const graph = constrained([["pending", ["approved"]]]);

    expect([...graph.reachableFrom("pending")]).toEqual(["approved"]);
  });

  it("names the states no path from the initial one ever enters", () => {
    const graph = constrained([["pending", ["approved"]]]);

    expect(graph.unreachableFrom("pending")).toEqual(["shipped"]);
  });

  it("refuses a second overlay rather than letting one silently replace another", () => {
    const graph = constrained([["pending", ["approved"]]]);

    expect(() => graph.declareEdges([["approved", ["shipped"]]])).toThrow(
      SECOND_OVERLAY
    );
  });

  it("refuses an edge naming a state it does not have, from either end", () => {
    expect(() => constrained([["cancelled", ["approved"]]])).toThrow(
      NO_SUCH_STATE
    );
    expect(() => constrained([["pending", ["cancelled"]]])).toThrow(
      NO_SUCH_STATE
    );
  });
});
