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

  describe("for a rule", () => {
    const matched = (policy: "reject" | "warn", id = "t7"): EkmanEvent => ({
      type: "violation",
      key: "jobs:1",
      seq: 1,
      at: 100,
      cause: { type: "rule.matched", id },
      constraint: { kind: "rule", name: "too-many" },
      policy,
      reason: "the condition held",
    });

    it("owes a proposal until the stream shows it answered, as for a bound", () => {
      expect(fold([matched("reject")])).toEqual({
        fired: [],
        owed: { "too-many": { type: "rule.matched", id: "t7" } },
      });
      expect(
        fold([
          matched("reject"),
          commit(2, "a", "a", { type: "rule.matched", id: "t7" }),
        ])
      ).toEqual({ fired: ["too-many"], owed: {} });
    });

    it("counts a warning as said", () => {
      expect(fold([matched("warn")])).toEqual({
        fired: ["too-many"],
        owed: {},
      });
    });

    it("reads a second match as a rule armed again in between", () => {
      // A rule ceasing to hold is not an event. Matching again is the only sign of it,
      // and the second proposal is owed whatever became of the first.
      expect(
        fold([
          matched("reject"),
          commit(2, "a", "a", { type: "rule.matched", id: "t7" }),
          // The commit that stopped the condition holding, then the one that made it
          // hold again. A second match always has both behind it.
          commit(3, "a", "a", { type: "probe", id: "t8" }),
          commit(4, "a", "a", { type: "probe", id: "t8" }),
          matched("reject", "t9"),
        ])
      ).toEqual({
        fired: [],
        owed: { "too-many": { type: "rule.matched", id: "t9" } },
      });
    });

    it("does not take a match a snapshot already accounts for as a new one", () => {
      // A snapshot says the rule is done, and the store hands back the violation that
      // made it so, since it carries the snapshot's own sequence. With no commit in
      // between it cannot be a second match.
      const seeded = new LatchFold({ fired: ["too-many"], owed: {} });
      seeded.apply(matched("reject"));
      expect(seeded.result()).toEqual({ fired: ["too-many"], owed: {} });

      // The same holds for one read twice in a stream, under either policy.
      expect(fold([matched("warn"), matched("warn")])).toEqual({
        fired: ["too-many"],
        owed: {},
      });
    });

    it("still reads a match after a later commit as a rule armed again", () => {
      const seeded = new LatchFold({ fired: ["too-many"], owed: {} });
      seeded.apply(commit(2, "a", "a", { type: "probe", id: "t8" }));
      seeded.apply(matched("reject", "t9"));
      expect(seeded.result()).toEqual({
        fired: [],
        owed: { "too-many": { type: "rule.matched", id: "t9" } },
      });
    });

    it("arms a rule again, dropping what it said and what it was owed", () => {
      const latch = new LatchFold();
      latch.apply(matched("warn"));
      latch.rearm("too-many");
      expect(latch.result()).toBeUndefined();

      latch.apply(matched("reject"));
      latch.rearm("too-many");
      expect(latch.result()).toBeUndefined();
    });
  });

  describe("for a freshness bound", () => {
    const asked = { type: "constraint.stale", id: "t7" };
    const quiet = (policy: "reject" | "warn"): EkmanEvent => ({
      type: "violation",
      key: "jobs:1",
      seq: 1,
      at: 100,
      cause: asked,
      constraint: { kind: "stale", name: "gone-quiet" },
      policy,
      reason: "nothing heard",
    });
    const other = { type: "probe", id: "t8" };
    const said = { fired: ["gone-quiet"], owed: {}, stale: ["gone-quiet"] };

    it("owes its trigger until the stream shows it answered", () => {
      expect(fold([quiet("reject")])).toEqual({
        fired: [],
        owed: { "gone-quiet": asked },
        stale: ["gone-quiet"],
      });
    });

    it("stays said through the commit that answers it, whether or not that moved the instance", () => {
      expect(fold([quiet("reject"), commit(2, "a", "a", asked)])).toEqual(said);

      const moved = new LatchFold();
      moved.apply(quiet("reject"));
      moved.moved(asked);
      expect(moved.result()).toEqual(said);
    });

    it("is armed again by the next commit from anything else", () => {
      expect(
        fold([
          quiet("reject"),
          commit(2, "a", "a", asked),
          commit(3, "a", "a", other),
        ])
      ).toBeUndefined();
      // Also when the proposal was still owed: the instance has been heard from.
      expect(
        fold([quiet("reject"), commit(2, "a", "a", other)])
      ).toBeUndefined();
      expect(fold([quiet("warn"), commit(2, "a", "a", other)])).toBeUndefined();

      const moved = new LatchFold();
      moved.apply(quiet("reject"));
      moved.moved(other);
      expect(moved.result()).toBeUndefined();
    });

    it("is forgotten by a move with no commit behind it, as on a reload", () => {
      const latch = new LatchFold();
      latch.apply(quiet("warn"));
      latch.moved();
      expect(latch.result()).toBeUndefined();
    });

    it("leaves a time-in-state bound alone when it is armed again", () => {
      expect(
        fold([violation("warn"), quiet("warn"), commit(2, "a", "a", other)])
      ).toEqual({ fired: ["too-slow"], owed: {} });
    });

    it("is armed again when another writer is known to have committed, leaving time-in-state bounds alone", () => {
      const latch = new LatchFold();
      latch.apply(violation("warn"));
      latch.apply(quiet("warn"));
      latch.heardElsewhere();
      expect(latch.result()).toEqual({ fired: ["too-slow"], owed: {} });
    });

    it("is carried by a snapshot and taken in from one", () => {
      const latch = new LatchFold(said);
      expect(latch.result()).toEqual(said);
      latch.apply(commit(3, "a", "a", other));
      expect(latch.result()).toBeUndefined();
    });

    it("is carried by a replay, so a reload does not ask again", () => {
      const replayed = replay({
        snapshot: undefined,
        seq: 2,
        events: [
          commit(0, null, "a", other),
          commit(1, "a", "a", other),
          { ...quiet("reject"), seq: 1 },
          commit(2, "a", "b", asked),
        ],
      });
      expect(replayed?.temporal).toEqual(said);
      expect(replayed?.lastCommittedAt).toBe(20);
    });
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

  it("says what a bound is owed and whether a cause is still outstanding", () => {
    const latch = new LatchFold();
    latch.apply(violation("reject"));

    expect(latch.hasFired("too-slow")).toBe(false);
    expect(latch.owed("too-slow")).toEqual(cause);
    expect(latch.owes(cause)).toBe(true);
    expect(latch.owes({ type: "poke", id: "t7" })).toBe(false);
    expect(latch.owes({ type: "constraint.temporal", id: "t8" })).toBe(false);

    latch.fire("too-slow");
    expect(latch.hasFired("too-slow")).toBe(true);
    expect(latch.owed("too-slow")).toBeUndefined();
    expect(latch.owes(cause)).toBe(false);
  });

  it("does not owe again what it has fired", () => {
    const latch = new LatchFold({ fired: ["too-slow"], owed: {} });
    latch.owe("too-slow", cause);
    expect(latch.result()).toEqual({ fired: ["too-slow"], owed: {} });
  });

  it("takes in another account of the same stay without forgetting its own", () => {
    const latch = new LatchFold({ fired: ["a"], owed: { b: cause } });
    latch.merge({ fired: ["b"], owed: { a: cause, c: cause } });

    expect(latch.result()).toEqual({ fired: ["a", "b"], owed: { c: cause } });
    latch.merge(undefined);
    expect(latch.result()).toEqual({ fired: ["a", "b"], owed: { c: cause } });
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
