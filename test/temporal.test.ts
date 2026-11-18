import { beforeEach, describe, expect, it } from "vitest";
import { EkmanError } from "../src/errors";
import type { EkmanEvent } from "../src/events";
import { replay } from "../src/store";
import { LatchFold, refusalOutcome, TemporalIndex } from "../src/temporal";

describe("TemporalIndex", () => {
  let index: TemporalIndex;

  beforeEach(() => {
    index = new TemporalIndex();
  });

  it("starts empty", () => {
    expect(index.size).toBe(0);
    expect(index.keys("orders", "pending")).toEqual([]);
    expect(index.states("orders")).toEqual([]);
  });

  it("records where a key sits", () => {
    index.enter("orders:1", "orders", "pending");
    index.enter("orders:2", "orders", "pending");

    expect(index.keys("orders", "pending")).toEqual(["orders:1", "orders:2"]);
    expect(index.size).toBe(2);
  });

  it("moves a key rather than listing it twice", () => {
    index.enter("orders:1", "orders", "pending");
    index.enter("orders:1", "orders", "approved");

    expect(index.keys("orders", "pending")).toEqual([]);
    expect(index.keys("orders", "approved")).toEqual(["orders:1"]);
    expect(index.size).toBe(1);
  });

  it("puts a re-entering key at the back, so entries stay oldest first", () => {
    index.enter("orders:1", "orders", "pending");
    index.enter("orders:2", "orders", "pending");
    index.enter("orders:1", "orders", "approved");
    index.enter("orders:1", "orders", "pending");

    // orders:1 entered `pending` most recently, so it sorts after orders:2 even though it
    // was there first. Time in state restarts on re-entry.
    expect(index.keys("orders", "pending")).toEqual(["orders:2", "orders:1"]);
  });

  it("keeps entities apart", () => {
    index.enter("orders:1", "orders", "pending");
    index.enter("carts:1", "carts", "pending");

    expect(index.keys("orders", "pending")).toEqual(["orders:1"]);
    expect(index.states("carts")).toEqual(["pending"]);
  });

  it("drops a key entirely", () => {
    index.enter("orders:1", "orders", "pending");
    index.remove("orders:1");

    expect(index.size).toBe(0);
    expect(index.keys("orders", "pending")).toEqual([]);
  });

  it("forgets a state once its last key leaves", () => {
    index.enter("orders:1", "orders", "pending");
    index.enter("orders:2", "orders", "pending");
    index.remove("orders:1");

    expect(index.states("orders")).toEqual(["pending"]);

    index.remove("orders:2");
    expect(index.states("orders")).toEqual([]);
  });

  it("ignores removal of a key it never held", () => {
    expect(() => index.remove("orders:404")).not.toThrow();
    expect(index.size).toBe(0);
  });
});

describe("classifying a refused escalation", () => {
  it("owes another try to one a closing runtime turned away", () => {
    expect(refusalOutcome(new EkmanError("RUNTIME_CLOSED", "closing"))).toBe(
      "refused-transiently"
    );
  });

  it("does not retry one the handler refused", () => {
    expect(refusalOutcome(new EkmanError("HANDLER_FAILED", "no"))).toBe(
      "refused"
    );
    expect(refusalOutcome(new Error("not ours"))).toBe("refused");
  });
});

describe("rebuilding what a stay in a state has already been told", () => {
  const cause = { type: "constraint.temporal", id: "t7" };
  const violation = (
    policy: "reject" | "warn",
    name = "too-slow"
  ): EkmanEvent => ({
    type: "violation",
    key: "jobs:1",
    seq: 1,
    at: 100,
    cause,
    constraint: { kind: "temporal", name },
    policy,
    reason: "too long",
  });
  const rejected = (code: "HANDLER_FAILED" | "INBOX_OVERFLOW"): EkmanEvent => ({
    type: "rejected",
    key: "jobs:1",
    seq: 1,
    at: 100,
    cause,
    code,
    reason: "no",
  });
  const commit = (
    seq: number,
    from: string | null,
    to: string,
    by = cause
  ): EkmanEvent => ({
    type: "transition",
    key: "jobs:1",
    from,
    to,
    seq,
    at: seq * 10,
    cause: by,
    values: {},
  });
  const fold = (events: readonly EkmanEvent[], seed?: LatchFold) => {
    const latch = seed ?? new LatchFold();
    for (const event of events) {
      latch.apply(event);
    }
    return latch.result();
  };

  it("has nothing to say when nothing fired", () => {
    expect(fold([])).toBeUndefined();
  });

  it("counts a warning as said, since nothing was to be delivered", () => {
    expect(fold([violation("warn")])).toEqual({
      fired: ["too-slow"],
      owed: {},
    });
  });

  it("owes an escalation until the stream shows it answered", () => {
    expect(fold([violation("reject")])).toEqual({
      fired: [],
      owed: { "too-slow": cause },
    });
  });

  it("settles what is owed when that trigger commits", () => {
    expect(fold([violation("reject"), commit(2, "a", "a")])).toEqual({
      fired: ["too-slow"],
      owed: {},
    });
  });

  it("settles what is owed when that trigger is refused for good", () => {
    expect(fold([violation("reject"), rejected("HANDLER_FAILED")])).toEqual({
      fired: ["too-slow"],
      owed: {},
    });
  });

  it("still owes it after a refusal that passes", () => {
    expect(fold([violation("reject"), rejected("INBOX_OVERFLOW")])).toEqual({
      fired: [],
      owed: { "too-slow": cause },
    });
  });

  it("is not settled by a commit some other trigger caused", () => {
    const other = commit(2, "a", "a", { type: "poke", id: "t7" });
    expect(fold([violation("reject"), other])?.owed).toEqual({
      "too-slow": cause,
    });
  });

  it("ignores violations of other kinds", () => {
    const guard: EkmanEvent = {
      type: "violation",
      key: "jobs:1",
      seq: 1,
      at: 100,
      cause,
      constraint: { kind: "guard", name: "g" },
      policy: "reject",
      reason: "no",
    };
    expect(fold([guard])).toBeUndefined();
  });

  it("starts from what a snapshot recorded, and does not owe again what has fired", () => {
    const seeded = new LatchFold({
      fired: ["too-slow"],
      owed: { "far-too-slow": cause },
    });
    expect(fold([violation("reject")], seeded)).toEqual({
      fired: ["too-slow"],
      owed: { "far-too-slow": cause },
    });
  });

  it("forgets everything when the instance moves", () => {
    const latch = new LatchFold({ fired: ["too-slow"], owed: {} });
    latch.moved();
    expect(latch.result()).toBeUndefined();
  });

  it("is carried by a replay, cleared by a move and kept by a stay", () => {
    const start = [
      commit(0, null, "a"),
      commit(1, "a", "a", { type: "x", id: "t1" }),
    ];
    expect(
      replay({
        snapshot: undefined,
        events: [...start, violation("warn")],
        seq: 1,
      })?.temporal
    ).toEqual({ fired: ["too-slow"], owed: {} });

    const stayed = commit(2, "a", "a", { type: "x", id: "t2" });
    expect(
      replay({
        snapshot: undefined,
        events: [...start, violation("warn"), stayed],
        seq: 2,
      })?.temporal
    ).toEqual({ fired: ["too-slow"], owed: {} });

    const moved = commit(2, "a", "b", { type: "x", id: "t2" });
    expect(
      replay({
        snapshot: undefined,
        events: [...start, violation("warn"), moved],
        seq: 2,
      })?.temporal
    ).toBeUndefined();
  });

  it("ignores a violation from before the snapshot it is replayed onto", () => {
    const snapshot = {
      key: "jobs:1",
      entity: "jobs",
      state: "a",
      values: {},
      seq: 5,
      enteredAt: 50,
      at: 60,
    };
    expect(
      replay({ snapshot, events: [violation("warn")], seq: 5 })?.temporal
    ).toBeUndefined();
    expect(
      replay({ snapshot, events: [{ ...violation("warn"), seq: 5 }], seq: 5 })
        ?.temporal
    ).toEqual({ fired: ["too-slow"], owed: {} });
  });
});
