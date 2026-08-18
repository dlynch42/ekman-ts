import { describe, expect, it } from "vitest";
import type { EkmanEvent } from "../src/events";
import { allowFrom, observeEdges } from "../src/observed";

const cause = { type: "message", id: "t1" } as const;

const transition = (
  from: string | null,
  to: string,
  seq: number
): EkmanEvent => ({
  type: "transition",
  key: "orders:1",
  from,
  to,
  seq,
  at: 1000 + seq,
  cause,
  values: {},
});

const violation = (
  from: string,
  to: string,
  policy: "reject" | "warn",
  kind: "transition" | "guard" = "transition"
): EkmanEvent => ({
  type: "violation",
  key: "orders:1",
  seq: 0,
  at: 1000,
  cause,
  constraint: { kind, name: kind === "transition" ? "transitions" : "guard:x" },
  policy,
  reason: "not declared",
  attempted: { from, to },
});

const edgesOf = (edges: ReadonlyMap<string, ReadonlySet<string>>) =>
  Object.fromEntries([...edges].map(([from, to]) => [from, [...to]]));

describe("observeEdges", () => {
  it("records every committed transition as an edge", () => {
    const observed = observeEdges([
      transition("pending", "paid", 1),
      transition("paid", "shipped", 2),
    ]);

    expect(edgesOf(observed.taken)).toEqual({
      pending: ["paid"],
      paid: ["shipped"],
    });
  });

  it("does not treat initialization as an edge", () => {
    // A null `from` is where the instance started, not a move it made. An edge into the
    // initial state from nowhere is not something any handler can be asked to declare.
    const observed = observeEdges([
      transition(null, "pending", 0),
      transition("pending", "paid", 1),
    ]);

    expect(edgesOf(observed.taken)).toEqual({ pending: ["paid"] });
  });

  it("dedupes an edge walked many times", () => {
    const observed = observeEdges([
      transition("pending", "paid", 1),
      transition("pending", "paid", 2),
      transition("pending", "paid", 3),
    ]);

    expect(edgesOf(observed.taken)).toEqual({ pending: ["paid"] });
  });

  it("counts an edge that only got through because the constraint was warning", () => {
    // Under warn the violation is recorded and the commit proceeds, so the transition event
    // is in the stream too. That is exactly what makes this the real graph.
    const observed = observeEdges([
      violation("shipped", "pending", "warn"),
      transition("shipped", "pending", 2),
    ]);

    expect(edgesOf(observed.taken)).toEqual({ shipped: ["pending"] });
    expect(edgesOf(observed.refused)).toEqual({});
  });

  it("keeps a refused edge apart from one that was taken", () => {
    const observed = observeEdges([
      transition("pending", "paid", 1),
      violation("shipped", "pending", "reject"),
    ]);

    expect(edgesOf(observed.taken)).toEqual({ pending: ["paid"] });
    expect(edgesOf(observed.refused)).toEqual({ shipped: ["pending"] });
  });

  it("ignores a violation that is not about a transition", () => {
    const observed = observeEdges([violation("a", "b", "reject", "guard")]);

    expect(edgesOf(observed.refused)).toEqual({});
  });

  it("ignores a violation carrying no attempted transition", () => {
    // A temporal violation is not attached to a result, so it has nothing to contribute.
    const temporal: EkmanEvent = {
      type: "violation",
      key: "orders:1",
      seq: 0,
      at: 1000,
      cause,
      constraint: { kind: "transition", name: "transitions" },
      policy: "reject",
      reason: "too long",
    };

    expect(edgesOf(observeEdges([temporal]).refused)).toEqual({});
  });

  it("ignores a restore, whose own `from` is not a state name at all", () => {
    // RestoredEvent.from is "snapshot" | "replay". Anything that matched on the field
    // rather than on the event type would quietly invent a state called "snapshot".
    const restored: EkmanEvent = {
      type: "restored",
      key: "orders:1",
      seq: 4,
      at: 1000,
      cause,
      from: "snapshot",
      replayed: 0,
    };

    expect(edgesOf(observeEdges([restored]).taken)).toEqual({});
  });

  it("accumulates across streams, because history is per key and a graph is not", () => {
    const first = observeEdges([transition("pending", "paid", 1)]);
    const second = observeEdges(
      [transition("paid", "shipped", 1), transition("pending", "cancelled", 2)],
      first
    );

    expect(edgesOf(second.taken)).toEqual({
      pending: ["paid", "cancelled"],
      paid: ["shipped"],
    });
    // The accumulator is copied rather than mutated, so the earlier answer still stands.
    expect(edgesOf(first.taken)).toEqual({ pending: ["paid"] });
  });

  it("is frozen, so a folded answer cannot be edited into a different one", () => {
    expect(Object.isFrozen(observeEdges([]))).toBe(true);
  });
});

describe("allowFrom", () => {
  it("produces a map that can be pasted into a transition constraint", () => {
    const observed = observeEdges([
      transition(null, "pending", 0),
      transition("pending", "paid", 1),
      transition("paid", "shipped", 2),
      transition("pending", "cancelled", 3),
    ]);

    expect(allowFrom(observed)).toEqual({
      pending: ["paid", "cancelled"],
      paid: ["shipped"],
    });
  });

  it("leaves refused edges out", () => {
    // They were refused. A map that re-admits them declares the thing enforcement already
    // decided against.
    const observed = observeEdges([
      transition("pending", "paid", 1),
      violation("paid", "pending", "reject"),
    ]);

    expect(allowFrom(observed)).toEqual({ pending: ["paid"] });
  });
});
